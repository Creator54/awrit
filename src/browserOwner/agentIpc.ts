import { type ConnectedClient, type IpcServer, startIpcServer } from '../ipc/socketServer';
import { queryKittyWindows } from '../presentation/kitty';
import { resolveKittyContext } from '../presentation/kittyDiscovery';
import { applyOverlayText, decodeOverlayTextRequest } from '../presentation/overlayText';
import type { AndroidTools } from '../remote/androidTools';
import type { WebContents } from 'electron';
import type { WindowView } from '../windows';
import { capturePagePng } from './pageCapture';
import { matchPane, type PaneIdentity, type PaneTarget, selectPane } from './target';
import { createBrowserToolRegistry } from './tools/browserTools';
import { createDispatcher, type DocumentId } from './tools/dispatch';
import { createNavigationTracker } from './tools/navigation';
import { markAgentActivity, showUserInControl } from './tools/preview';
import { waitForUserIdle } from './tools/userActivity';
import { associateViewer } from './viewerAssociation';

export interface AgentPane extends PaneIdentity {
  view: WindowView;
  close: () => void;
  /** Device tools when the shown page is an Android screen; web tools otherwise. */
  androidTools?: () => AndroidTools | undefined;
}

function decodeTarget(value: unknown): PaneTarget {
  if (!value || typeof value !== 'object') throw new Error('Invalid viewer target');
  const target: PaneTarget = {};
  for (const key of ['paneId', 'sourceWindowId', 'kittyWindowId'] as const) {
    if (key in value) {
      const field = Reflect.get(value, key);
      if (typeof field !== 'string' || !field.length || field.length > 128)
        throw new Error('Invalid viewer target field');
      target[key] = field;
    }
  }
  return target;
}

/** Viewers opened from one terminal window; other windows' viewers are never reported. */
export function describeWindowViewers(allPanes: AgentPane[], sourceWindowId: string) {
  return allPanes
    .filter(
      (pane) =>
        pane.sourceWindowId === sourceWindowId &&
        !pane.view.destroyed &&
        !pane.view.content.webContents.isDestroyed(),
    )
    .map((pane) => {
      const wc = pane.view.content.webContents;
      return {
        paneId: pane.id,
        url: wc.getURL(),
        loading: wc.isLoading(),
        designMode: Boolean(pane.view.designMode),
      };
    });
}

/** Binds a newly connected agent to the one live viewer opened from its terminal window. */
export function adoptPaneForHandshake(allPanes: AgentPane[], client: ConnectedClient) {
  if (!client.windowId) return { adopted: false };
  const panes = allPanes.filter(
    (pane) => pane.sourceWindowId === client.windowId && !pane.view.destroyed,
  );
  // More than one match means we cannot tell which viewer the agent belongs to.
  if (panes.length !== 1) return { adopted: false };
  const pane = panes[0];
  pane.view.binding = {
    state: 'bound',
    clientSocket: client.socket,
    harness: client.harness,
    sourceWindowId: client.windowId,
    agentPid: client.pid,
    cwd: client.cwd,
  };
  return { adopted: true, paneId: pane.id, kittyWindowId: pane.kittyWindowId };
}

export async function startOwnerAgentIpc(getPanes: () => AgentPane[]): Promise<IpcServer> {
  const server = await startIpcServer();
  const registry = createBrowserToolRegistry();
  const dispatcher = createDispatcher(registry);
  const currentDocument = createNavigationTracker((doc) => dispatcher.invalidateDocument(doc));
  const resolveTarget = async (request: unknown) => {
    const target = decodeTarget(request);
    if (
      target.sourceWindowId &&
      !getPanes().some(
        (pane) => !pane.view.destroyed && pane.sourceWindowId === target.sourceWindowId,
      )
    ) {
      try {
        const ctx = await resolveKittyContext({ timeoutMs: 100 });
        if (ctx) {
          const windows = await queryKittyWindows({ endpoint: ctx.endpoint, timeoutMs: 250 });
          const tabs: string[][] = windows.flatMap((os) =>
            (os.tabs ?? []).map((tab: { windows?: { id: number }[] }) =>
              (tab.windows ?? []).map((window) => String(window.id)),
            ),
          );
          associateViewer(getPanes(), target.sourceWindowId, tabs);
        }
      } catch {
        // Discovery failure must not attach a different window's viewer.
      }
    }
    return target;
  };
  const choose = async (request: unknown) =>
    selectPane(
      getPanes().filter((pane) => !pane.view.destroyed),
      await resolveTarget(request),
    );
  // A Viewer that closed can leave its content/WebContents unusable; avoid dereferencing
  // them while a device pane still answers adb.
  const safeWebContents = (pane: AgentPane): WebContents | undefined => {
    try {
      const wc = pane.view.content?.webContents;
      return wc && !wc.isDestroyed() ? wc : undefined;
    } catch {
      return undefined;
    }
  };
  server.onRequest('capture:request', async (request) => {
    const pane = await choose(request);
    if (pane.view.adbMode && pane.view.adbSerial) {
      // The device screen at full size, so its pixels are the x/y the Android tools take.
      const { captureDeviceScreenshot } = await import('../adb/androidManager');
      const shot = await captureDeviceScreenshot(pane.view.adbSerial);
      if (!shot.ok || !shot.base64) throw new Error(shot.error ?? 'Android screenshot failed');
      return {
        base64: shot.base64,
        url: pane.view.adbSerial,
        isAdb: true,
        paneId: pane.id,
        kittyWindowId: pane.kittyWindowId,
      };
    }
    const reqObj: Record<string, unknown> =
      request && typeof request === 'object' ? { ...request } : {};
    const shot = await capturePagePng(pane.view, {
      ...(typeof reqObj.waitMs === 'number' ? { waitMs: reqObj.waitMs } : {}),
      ...(typeof reqObj.waitSelector === 'string' ? { waitSelector: reqObj.waitSelector } : {}),
    });
    return {
      inputWidth: shot.inputWidth,
      inputHeight: shot.inputHeight,
      base64: shot.png.toString('base64'),
      url: shot.url,
      width: shot.width,
      height: shot.height,
      paneId: pane.id,
      kittyWindowId: pane.kittyWindowId,
    };
  });
  server.onRequest('viewer:navigate', async (request) => {
    const target = await resolveTarget(request);
    const match = matchPane(
      getPanes().filter((pane) => !pane.view.destroyed),
      target,
    );
    if (!match.ok) {
      return {
        navigated: false,
        reason: 'no-matching-viewer',
      };
    }
    const pane = match.pane;
    if (pane.view.designMode)
      return {
        navigated: false,
        reason: 'design-mode-active',
        url: pane.view.content.webContents.getURL(),
        kittyWindowId: pane.kittyWindowId,
      };
    if (typeof request.target !== 'string' || !request.target.trim())
      throw new Error('Missing navigation target');
    await pane.view.content.loadURL(request.target.trim());
    return {
      navigated: true,
      url: pane.view.content.webContents.getURL(),
      paneId: pane.id,
      kittyWindowId: pane.kittyWindowId,
    };
  });
  server.onRequest('viewer:close', async (request) => {
    const pane = await choose(request);
    pane.close();
    return { closed: true, paneId: pane.id };
  });
  server.onRequest('viewer:status', async (request) => {
    const { sourceWindowId } = await resolveTarget(request);
    if (!sourceWindowId) return { viewers: [] };
    return { viewers: describeWindowViewers(getPanes(), sourceWindowId) };
  });
  server.onRequest('overlay:text', async (request) => {
    const overlay = decodeOverlayTextRequest(request);
    const pages = getPanes()
      .filter((pane) => !pane.view.destroyed && !pane.view.content.webContents.isDestroyed())
      .map((pane) => pane.view.content.webContents);
    return { action: await applyOverlayText(pages, overlay) };
  });
  server.onRequest('tools:list', async (request) => {
    const pane = await choose(request).catch(() => undefined);
    const android = pane?.androidTools?.();
    return { tools: android ? android.list() : registry.listTools() };
  });
  server.onRequest('tool:call', async (request, socket) => {
    const pane = await choose(request);
    // A viewer's WebContents can be gone while the device still answers; Android tools
    // only need it for the presence/leisure visuals, so run them before checking the view.
    const wc = safeWebContents(pane);
    const name = Reflect.get(request, 'name');
    if (typeof name !== 'string') throw new Error('Invalid tool name');
    const input = Reflect.get(request, 'arguments') ?? {};
    const agent = Reflect.get(request, 'agent');
    if (typeof agent === 'string' && wc) markAgentActivity(wc, agent.slice(0, 24));
    const android = pane.androidTools?.();
    if (android) {
      if (
        name !== 'snapshot' &&
        !(await waitForUserIdle(() => (wc ? showUserInControl(wc) : true)))
      ) {
        return { ok: false, error: 'The user is using the device right now. Try again in a moment.' };
      }
      return android.call(name, input);
    }
    if (!wc) return { ok: false, outcome: 'not-started' };
    const requested = Reflect.get(request, 'timeoutMs');
    const timeoutMs = Math.min(
      30000,
      Math.max(1, typeof requested === 'number' ? requested : 10000),
    );

    // Pin the call to the document the pane shows right now; navigation during the call
    // makes the dispatcher refuse to run queued work against the new page.
    const doc: DocumentId = currentDocument(wc);
    dispatcher.updatePaneBinding(pane.id, {
      currentDocument: doc,
      clientSocket: socket,
      webContents: wc,
    });
    return dispatcher.call(pane.id, name, input, doc, timeoutMs);
  });
  server.onHandshake = async (client) => {
    if (client.windowId) await resolveTarget({ sourceWindowId: client.windowId });
    return adoptPaneForHandshake(getPanes(), client);
  };
  server.onDisconnect = (client) => {
    dispatcher.disconnectSocket(client.socket);
    for (const pane of getPanes()) {
      if (pane.view.binding?.clientSocket === client.socket) {
        pane.view.binding.clientSocket = undefined;
        pane.view.binding.state = 'orphaned';
      }
    }
  };
  return server;
}
