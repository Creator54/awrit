import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { AdbServerInstance, createAdbControl } from '../adb/adbControl';
import { getAdbSerialForDevice } from '../adb/androidManager';
import { type AndroidTools, createAndroidHttpTools } from '../remote/androidTools';
import type { createCompanionHtmlFile } from '../presentation/companion';
import { resolvePresentationTarget } from '../presentation/target';
import type { getProfileSession } from '../session';
import { createSyntheticInputGuard } from '../syntheticInput';
import { getTabThumbnail } from '../tabThumbnail';
import type { createTerminalContext } from '../terminal/context';
import type { WindowView, createWindowWithToolbar } from '../windows';
import type { AgentPane } from './agentIpc';
import type { AttachRequest } from './attach';
import { PanePages } from './pages';
import { showDevicePreview } from './tools/preview';
import { validInput, validSize } from './validation';

export interface PaneSocket {
  readonly destroyed: boolean;
  end(): void;
  destroy(): void;
}

export interface PaneOutput {
  writeOutput(bytes: Uint8Array): boolean;
  writeControl(bytes: Uint8Array): boolean;
}

/** The config fields a pane reads while it is attached; reloads apply to live panes. */
export interface PaneConfig {
  homepage: string;
  profile?: string | null;
  urlBar?: { defaultVisible?: boolean };
  kitty?: { quitOnCtrlC?: boolean };
}

export interface PaneSessionDeps {
  connectionId: string;
  build: string;
  socket: PaneSocket;
  output: PaneOutput;
  assetDirectory: string;
  getConfig: () => PaneConfig;
  agentPanes: Map<string, AgentPane>;
  request: AttachRequest;
  createTerminal: typeof createTerminalContext;
  createWindow: typeof createWindowWithToolbar;
  createInputHandler: typeof import('../inputHandler').createInputHandler;
  getProfileSession: typeof getProfileSession;
  createAdbControl: typeof createAdbControl;
  createCompanionFile: typeof createCompanionHtmlFile;
}

/** One viewer connection: its pages, Android streams, terminal and input handler. */
export function createPaneSession(deps: PaneSessionDeps) {
  const { connectionId, build, socket, request, agentPanes, getConfig, assetDirectory } = deps;
  const writer = deps.output;
  let view: WindowView | undefined;
  const pages = new PanePages<WindowView>();
  const androidStreams = new Set<AdbServerInstance>();
  const androidTools = new WeakMap<WindowView, AndroidTools>();
  const companionCleanups = new Set<() => void>();
  let handle: ReturnType<PaneSessionDeps['createInputHandler']> | undefined;
  const syntheticInput = createSyntheticInputGuard();
  let closed = false;
  const terminal = deps.createTerminal(
    randomUUID(),
    request.size,
    request.features,
    (data) => writer.writeOutput(Buffer.from(data)),
    request.settings,
    { sourceWindowId: request.sourceWindowId, kittyWindowId: request.kittyWindowId, terminalScheme: request.terminalScheme, terminalBackground: request.terminalBackground },
  );
  const createPage = async (url: string, android?: typeof request.android) => {
    if (closed || socket.destroyed) return undefined;
    let stream: AdbServerInstance | undefined;
    const adbSerial = android?.target ? getAdbSerialForDevice(android.target) : undefined;
    if (android) {
      stream = await deps.createAdbControl(
        adbSerial,
        {
          maxSize: android.maxSize,
          bitrate: android.bitrate,
          viewport: terminal.size,
          companion: request.companion,
          overlay: request.settings.overlay,
        },
      );
      if (closed || socket.destroyed) {
        stream.stop();
        return undefined;
      }
      androidStreams.add(stream);
      url = stream.url;
    } else if (request.companion) {
      try {
        const target = resolvePresentationTarget(url);
        const file = deps.createCompanionFile({ ...request.companion, target });
        companionCleanups.add(file.cleanup);
        url = pathToFileURL(file.filePath).href;
      } catch (error) {
        console.error('Companion file setup failed:', error);
      }
    }
    try {
      const session = await deps.getProfileSession(request.profile ?? getConfig().profile ?? null);
      if (closed || socket.destroyed) return undefined;
      let page: WindowView | undefined;
      page = await deps.createWindow(terminal.size, url, {
        session,
        assetDirectory,
        terminal,
        urlBarVisible: getConfig().urlBar?.defaultVisible,
        adbMode: Boolean(stream),
        adbSerial,
        adbServerUrl: stream?.url,
        onResize: stream?.resize,
        isActive: () => page !== undefined && pages.current === page,
      });
      if (closed || socket.destroyed) {
        page.destroy();
        return undefined;
      }
      pages.add(page);
      if (stream) {
        const control = stream;
        const shown = page.content.webContents;
        androidTools.set(
          page,
          createAndroidHttpTools(
            (path, init) => fetch(new URL(path, control.url), init),
            control.resolution,
            (at, label, press) =>
              shown.isDestroyed()
                ? Promise.resolve()
                : showDevicePreview(shown, at, control.resolution(), label, press),
          ),
        );
      }
      view = page;
      const pane = agentPanes.get(connectionId);
      if (pane) pane.view = page;
      page.relayout(true);
      return page;
    } catch (error) {
      stream?.stop();
      if (stream) androidStreams.delete(stream);
      throw error;
    }
  };
  const showPage = (next: WindowView | undefined) => {
    if (!next) return false;
    if (view?.keyHelpVisible) view.toggleKeyHelp();
    if (view?.omniboxVisible) view.toggleOmnibox();
    view = next;
    const pane = agentPanes.get(connectionId);
    if (pane) pane.view = next;
    next.relayout(true);
    return true;
  };
  terminal.actions = {
    close: () => {
      socket.end();
    },
    newWindow: (url) => {
      void createPage(url ?? getConfig().homepage, undefined).catch((error) =>
        console.error('Cannot create page:', error),
      );
    },
    cycle: (step) => showPage(pages.cycle(step)),
    select: (index) => showPage(pages.select(index)),
    list: () =>
      pages.all().map((page) => ({
        id: page.content.webContents.id,
        thumbnail: getTabThumbnail(page.content.webContents),
        title: page.content.webContents.getTitle(),
        url: page.content.webContents.getURL(),
        current: page === pages.current,
      })),
    closeTabAt: (index) => {
      const closing = pages.all()[index];
      if (!closing) return false;
      const result = pages.closeAt(index);
      if (!result) return false;
      if (result.next && result.next !== view) showPage(result.next);
      result.closed.destroy();
      if (!result.next) socket.end();
      return true;
    },
    closeTab: () => {
      const result = pages.closeCurrent();
      if (!result) return false;
      if (result.next) showPage(result.next);
      result.closed.destroy();
      // Closing the last tab ends the pane, like closing the last window.
      if (!result.next) socket.end();
      return true;
    },
  };
  createPage(request.url || getConfig().homepage, request.android)
    .then((created) => {
      if (!created || closed || socket.destroyed) {
        created?.destroy();
        return;
      }
      view = created;
      if (request.sourceWindowId) {
        view.binding = { state: 'orphaned', sourceWindowId: request.sourceWindowId };
      }
      agentPanes.set(connectionId, {
        id: terminal.id,
        sourceWindowId: request.sourceWindowId,
        kittyWindowId: request.kittyWindowId,
        view,
        close: () => socket.end(),
        androidTools: () => (view ? androidTools.get(view) : undefined),
      });
      handle = deps.createInputHandler(
        () => view ?? null,
        () => pages.all(),
        request.settings.overlay,
        syntheticInput,
      );
      handle.setDismissOverlayHandler(() => socket.end());
      writer.writeControl(
        Buffer.from(
          JSON.stringify({ type: 'attached', version: 1, build, paneId: terminal.id }),
        ),
      );
    })
    .catch(() => socket.destroy());
  function handleMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null || !('type' in msg))
      throw new Error('Invalid control');
    if (msg.type === 'resize') {
      if (!('size' in msg) || !validSize(msg.size)) throw new Error('Invalid resize');
      terminal.size = msg.size;
      view?.relayout();
    } else if (msg.type === 'input') {
      if (!('event' in msg) || !validInput(msg.event)) throw new Error('Invalid input');
      if (msg.event.eventType === 'graphics') {
        terminal.acknowledgeGraphics(msg.event.graphics?.id ?? '');
      } else if (
        msg.event.eventType === 'key' &&
        msg.event.keyEvent?.down &&
        msg.event.keyEvent.code === 'c' &&
        msg.event.keyEvent.modifiers.includes('ctrl')
      ) {
        if (!handle?.handleInput(msg.event) && getConfig().kitty?.quitOnCtrlC !== false)
          socket.end();
      } else handle?.handleInput(msg.event);
    } else throw new Error('Unknown terminal command');
  }
  function close(): void {
    if (closed) return;
    closed = true;
    // Every step runs even if an earlier one throws; the first error is rethrown.
    const errors: unknown[] = [];
    const attempt = (step: () => void) => {
      try {
        step();
      } catch (error) {
        errors.push(error);
      }
    };
    attempt(() => handle?.dispose());
    agentPanes.delete(connectionId);
    for (const page of pages.clear()) attempt(() => page.destroy());
    for (const stream of androidStreams) attempt(() => stream.stop());
    androidStreams.clear();
    for (const cleanup of companionCleanups) attempt(cleanup);
    companionCleanups.clear();
    attempt(() => terminal.dispose());
    if (errors.length > 0) throw errors[0];
  }
  return { handle: handleMessage, close };
}
