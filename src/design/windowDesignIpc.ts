import {
  type BrowserWindow,
  clipboard,
  type ipcMain,
  nativeImage,
} from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { console_ } from '../console';
import { getIpcServer } from '../ipc/socketServer';
import { selectFeedbackClient } from '../ipc/feedbackRouting';
import { getAppDataPath } from '../paths';
import type { TerminalContext } from '../terminal/context';
import { updateCaptureSentRevisions } from '../presentation/collaborativeCapture';
import { acceptedRevisions } from './sentRevisions';
import { loadDraft, saveDraft } from './draftStore';
import { loadReviewSession, saveReviewCapture } from './reviewSession';
import { readTerminalCapture, TERMINAL_ID } from './terminalReview';
import { persistFeedbackArtifacts } from './feedbackArtifacts';
import { verifySourceFeedback } from './sourceFeedback';
import { formatNotes, terminalLabel } from './notes';
import { initSessionWorkspace } from '../session/workspace';
import type { CaptureProvenance } from '../remote/captureProvenance';
import type { Dimensions, FrozenSource } from './types';
import { readCodeSnapshot } from './codeSource';
import { validateDesignDraft } from './validation';
import type { WindowView } from '../windows';

/** The frozen frame the design toolbar is reviewing; owned by createWindowWithToolbar. */
export interface DesignCaptureMeta {
  captureId: string;
  captureSha256: string;
  captureProvenance?: CaptureProvenance;
  pngDims: Dimensions;
  source?: FrozenSource;
  restored?: boolean;
  snapshot?: { path: string; sha256: string; text: string };
}

/** Per-window values the design and review handlers close over. */
export interface WindowDesignIpcDeps {
  content: BrowserWindow;
  toolbar: BrowserWindow;
  toolbarContentsId: number;
  view: WindowView;
  terminal: TerminalContext | undefined;
  terminalReview: { windowId: string; imagePath: string } | undefined;
  /** Remote pane: hand copied text to the owner instead of writing this host's clipboard. */
  onCopyToClipboard: ((text: string) => void) | undefined;
  out: {
    write: (data: string) => unknown;
    writeToTerminalClipboard: (text: string) => unknown;
  };
  /** `--source-window-id`, used when this pane has no terminal identity. */
  sourceWindowIdOption: string | undefined;
  loadToolbarContent: () => void;
  listen: (channel: string, handler: Parameters<typeof ipcMain.on>[1]) => void;
  registerToolbarHandler: (channel: string, sender: number, handler: (...args: any[]) => unknown) => void;
  isDestroyed: () => boolean;
  getCaptureMeta: () => DesignCaptureMeta | null;
  setCaptureMeta: (meta: DesignCaptureMeta | null) => void;
}

export interface WindowDesignIpc {
  /** Recapture the terminal source after a review resize; view.relayout schedules it. */
  requestTerminalRefresh: () => Promise<void>;
  /** Terminal review startup; the window runs it once the toolbar load begins. */
  initializeTerminalReview: () => void;
}

/**
 * Registers the design capture and review IPC handlers for one window.
 * They are per-window closures, so their bodies stay together here.
 */
export function registerDesignIpc(deps: WindowDesignIpcDeps): WindowDesignIpc {
  const {
    toolbar,
    content,
    toolbarContentsId,
    view,
    terminal,
    terminalReview,
    onCopyToClipboard,
    out,
    sourceWindowIdOption,
    loadToolbarContent,
    listen,
    registerToolbarHandler,
    isDestroyed,
    getCaptureMeta,
    setCaptureMeta,
  } = deps;

  let draftSaveQueue: Promise<unknown> = Promise.resolve();
  const onSaveDesignDraft = (event: Electron.IpcMainInvokeEvent, draft: unknown) => {
    const result = draftSaveQueue.then(() => saveDesignDraftInOrder(event, draft));
    // A rejected request must not prevent later deliberate saves.
    draftSaveQueue = result.catch(() => {});
    return result;
  };

  const saveDesignDraftInOrder = async (event: Electron.IpcMainInvokeEvent, draft: unknown) => {
    if (event.sender !== toolbar.webContents) {
      return { ok: false, error: 'Unauthorized sender' };
    }
    const captureMeta = getCaptureMeta();
    if (!captureMeta?.source) {
      return { ok: false, error: 'No active frozen frame capture' };
    }
    try {
      if (typeof draft === 'object' && draft !== null) {
        Object.assign(draft, { source: captureMeta.source, captureProvenance: captureMeta.captureProvenance });
      }
      const validated = validateDesignDraft(draft, captureMeta.pngDims);
      const capture = captureMeta;
      if (validated.captureId !== capture.captureId || validated.captureSha256 !== capture.captureSha256) throw new Error('Capture identity does not match active review');
      if (validated.annotations.some(note => note.sourceRange)) {
        const snapshot = capture.restored ? capture.snapshot : await readCodeSnapshot(content.webContents.getURL());
        verifySourceFeedback(validated.annotations, capture.source, snapshot);
        if (getCaptureMeta() !== capture) throw new Error('Capture changed while validating source context');
      }
      saveDraft(validated, capture.pngDims);
      return { ok: true, id: validated.id, draft: validated };
    } catch (err: any) {
      console_.error('Failed to save design draft:', err);
      // Validation errors carry actionable messages; filesystem failures must not leak
      // their raw text to the user.
      const fsFailure = Boolean(err && typeof err === 'object' && typeof err.code === 'string');
      return {
        ok: false,
        error: fsFailure
          ? 'The design draft could not be saved. Check free space and permissions, then try again.'
          : String(err?.message || err),
      };
    }
  };

  const onSendDesignFeedback = async (event: Electron.IpcMainInvokeEvent, draft: unknown) => {
    const saveRes = await onSaveDesignDraft(event, draft);
    if (!saveRes.ok || !saveRes.id) {
      return saveRes;
    }

    try {
      const d = saveRes.draft;
      const deliveryDims = getCaptureMeta()?.pngDims;
      if (!deliveryDims) throw new Error('Capture dimensions unavailable');
      if (!d) throw new Error('Validated feedback is unavailable');
      // Pins are numbered by position in the whole review, so a partial send must reuse
      // those numbers instead of renumbering the submitted notes from one.
      const reviewDraft = Array.isArray(d.annotations) ? loadDraft(d.captureId, deliveryDims) : null;
      const reviewNumbers = reviewDraft
        ? new Map(reviewDraft.annotations.map((note, index) => [note.id, index + 1] as const))
        : undefined;
      const noteNumbers =
        reviewNumbers && d.annotations.every((note) => reviewNumbers.has(note.id))
          ? reviewNumbers
          : undefined;
      const notes = Array.isArray(d.annotations)
        ? formatNotes(d.annotations, undefined, noteNumbers)
        : '';

      const session = initSessionWorkspace();
      const sessionPngPath = d.captureId
        ? path.join(session.dir, `${d.captureId}.png`)
        : undefined;
      const globalPngPath = d.captureId
        ? path.join(getAppDataPath(), 'captures', `${d.captureId}.png`)
        : undefined;

      let capturePngPath =
        sessionPngPath && fs.existsSync(sessionPngPath)
          ? sessionPngPath
          : globalPngPath && fs.existsSync(globalPngPath)
            ? globalPngPath
            : undefined;

      // Crop screenshot if the user selected a specific element or region box (only for single annotation; multi-annotation preserves full frame)
      const firstAnnotation = Array.isArray(d.annotations) && d.annotations.length === 1 ? d.annotations[0] : null;
      const cropBounds = firstAnnotation?.selection?.bounds;

      if (capturePngPath && cropBounds && cropBounds.width > 0 && cropBounds.height > 0) {
        try {
          const rawBuffer = fs.readFileSync(capturePngPath);
          const fullImg = nativeImage.createFromBuffer(rawBuffer);
          const imgSize = fullImg.getSize();

          // Clamp crop rectangle within image boundaries
          const cropX = Math.max(0, Math.min(Math.round(cropBounds.x), imgSize.width - 1));
          const cropY = Math.max(0, Math.min(Math.round(cropBounds.y), imgSize.height - 1));
          const cropW = Math.max(
            1,
            Math.min(Math.round(cropBounds.width), imgSize.width - cropX),
          );
          const cropH = Math.max(
            1,
            Math.min(Math.round(cropBounds.height), imgSize.height - cropY),
          );

          // Only crop if it's genuinely a sub-region (not full screen)
          if (cropW < imgSize.width - 4 || cropH < imgSize.height - 4 || cropX > 4 || cropY > 4) {
            const croppedImg = fullImg.crop({
              x: cropX,
              y: cropY,
              width: cropW,
              height: cropH,
            });
            const croppedPng = croppedImg.toPNG();
            const croppedFilename = `${d.captureId}-crop-${cropX}_${cropY}_${cropW}x${cropH}.png`;
            const croppedPath = path.join(session.dir, croppedFilename);
            fs.writeFileSync(croppedPath, croppedPng, { mode: 0o600 });
            capturePngPath = croppedPath;
          }
        } catch (cropErr) {
          console_.error('[Design] Failed to crop selection PNG:', cropErr);
        }
      }

      // Agent follow-ups can be consumed after this viewer's session is gone.
      const artifacts = persistFeedbackArtifacts(saveRes.id, JSON.stringify(d, null, 2), capturePngPath);
      capturePngPath = artifacts.capturePath;

      // Hard invariant: never mislead the agent into searching for non-existent files.
      // Omit internal JSON path from summary; supply exact screenshot path and instructions.
      const srcUrl = d.source.kind === 'web' ? d.source.url : d.source.kind === 'adb' ? d.source.serial : d.source.kind === 'terminal' ? terminalLabel(d.source.windowId) : d.source.path;
      const sourceHash = d.source?.kind === 'document' && d.source.sha256 ? `Source SHA-256: ${d.source.sha256}` : '';
      const summaryText = [
        srcUrl ? `[Design Feedback] ${srcUrl}` : `[Design Feedback]`,
        sourceHash,
        d.captureProvenance ? `Captured attachment: session=${d.captureProvenance.session}, generation=${d.captureProvenance.generation}, viewportEpoch=${d.captureProvenance.epoch} (historical evidence, not authorization or current deployment identity)` : '',
        notes,
        capturePngPath ? `Screenshot: ${capturePngPath}` : '',
      ]
        .filter(Boolean)
        .join('\n');

      // The clipboard is only the fallback when no agent can receive the notes; never overwrite it otherwise.
      const noAgent = (error: string) => {
        if (!onCopyToClipboard) {
          clipboard.writeText(summaryText);
          out.writeToTerminalClipboard(summaryText);
        }
        return {
          ok: false, id: saveRes.id,
          error: onCopyToClipboard ? `${error}. Notes saved on the remote host but not delivered or copied.` : error,
          noConnectedAgent: true,
        };
      };

      const draftPath = artifacts.draftPath;

      const dynamicSourceWindowId =
        view.binding?.sourceWindowId ||
        terminal?.identity.sourceWindowId ||
        (!terminal && sourceWindowIdOption
          ? String(sourceWindowIdOption).trim()
          : undefined) ||
        process.env.AWRIT_SOURCE_WINDOW_ID;

      const ipc = getIpcServer();
      if (ipc) {
        const payload = {
          draftId: saveRes.id,
          captureId: d.captureId,
          capturePath: capturePngPath,
          draftPath,
          summary: summaryText,
          source: d.source,
          kittyWindowId: terminal?.identity.kittyWindowId ?? process.env.KITTY_WINDOW_ID,
          sourceWindowId: dynamicSourceWindowId,
        };

        const recipient = selectFeedbackClient(
          ipc.getClients(),
          dynamicSourceWindowId,
          view.binding?.clientSocket,
        );
        if (!recipient) return noAgent('No connected agent/LLM found for this window');

        const result = await ipc.sendFeedback(recipient, payload);
        if (!result.ok) {
          return {
            ok: false,
            id: saveRes.id,
            error: result.error,
          };
        }
      } else {
        return noAgent('IPC server not running (no connected agent/LLM)');
      }

      // Persist only after acknowledgement; failed/unknown delivery stays pending.
      // Recording a delivered acknowledgement is best-effort: the user must never be
      // told to send again, so a failure here is logged instead of reported.
      const accepted = { ...d, state: 'accepted' as const };
      // Each record is saved on its own so one failure does not skip the other.
      try {
        updateCaptureSentRevisions(d.captureId, acceptedRevisions([accepted]));
      } catch (persistErr) {
        console_.error('[Design] Feedback delivered but sent notes not recorded:', persistErr);
      }
      try {
        saveDraft(accepted, deliveryDims);
      } catch (persistErr) {
        console_.error('[Design] Feedback delivered but not recorded as accepted:', persistErr);
      }

      // Close design mode smoothly only after acknowledged delivery
      if (view.designMode) {
        view.toggleDesignMode();
      }

      return { ok: true, id: saveRes.id };
    } catch (_err: any) {
      return {
        ok: false,
        id: saveRes.id,
        error: 'Feedback saved but could not be sent',
      };
    }
  };

  let openReviewToken = 0;
  const openReviewSession = async (event: unknown, id: unknown) => {
    const sender = (event as Electron.IpcMainInvokeEvent)?.sender;
    if (typeof id !== 'string' || !id || isDestroyed() || toolbar.isDestroyed() || toolbar.webContents.isDestroyed()) return undefined;
    if (sender !== toolbar.webContents) return undefined;
    if (view.keyHelpVisible || view.permissionPending) return undefined;
    if (view.omniboxVisible) view.toggleOmnibox();
    const token = ++openReviewToken;
    const previous = getCaptureMeta();
    const session = await loadReviewSession(id);
    if (!session || token !== openReviewToken || getCaptureMeta() !== previous || isDestroyed() || toolbar.isDestroyed() || toolbar.webContents.isDestroyed()) return undefined;
    if (view.keyHelpVisible || view.permissionPending) return undefined;

    (content as any).isSuppressingPaint = true;
    view.designMode = true;
    setCaptureMeta({
      captureId: session.captureId,
      captureSha256: session.captureSha256,
      captureProvenance: session.captureProvenance,
      pngDims: { width: session.width, height: session.height },
      source: session.source,
      snapshot: session.snapshot,
      restored: true,
    });

    toolbar.setIgnoreMouseEvents(false);
    toolbar.focusOnWebView();
    toolbar.focus();
    toolbar.webContents.send('awrit:design-mode-changed', true);
    content.webContents.send('awrit:set-design-mode', true);
    toolbar.webContents.send('awrit:design-frozen-frame', {
      png: session.png,
      width: session.width,
      height: session.height,
      captureId: session.captureId,
      captureSha256: session.captureSha256,
      source: session.source,
      draft: session.draft,
      sentRevisions: session.sentRevisions,
      restored: true,
    });

    return session;
  };
  const reviewRecipients = new Map<string, import('../ipc/socketServer').ConnectedClient>();
  registerToolbarHandler('awrit:list-review-recipients', toolbarContentsId, () => {
    if (!terminalReview) return [];
    const clients = (getIpcServer()?.getClients() ?? []).filter(client => !client.socket.destroyed && client.feedbackAck && client.windowId);
    for (const [id, client] of reviewRecipients) if (!clients.includes(client)) reviewRecipients.delete(id);
    const source = view.binding?.sourceWindowId;
    const matching = clients.filter(client => client.windowId === source);
    const boundSocket = view.binding?.clientSocket;
    const preferred = boundSocket ? matching.find(client => client.socket === boundSocket) : (matching.length === 1 ? matching[0] : undefined);
    return clients.map(client => {
      const id = [...reviewRecipients].find(([, existing]) => existing === client)?.[0] ?? crypto.randomBytes(12).toString('hex');
      reviewRecipients.set(id, client);
      return { id, label: `${client.harness || 'Agent'}${client.windowId ? ` — ${client.windowId.includes('-') && TERMINAL_ID.test(client.windowId) ? 'TUIOS pane' : `split ${client.windowId}`}` : ''}${client.cwd ? ` — ${client.cwd}` : ''}`, preferred: client === preferred };
    });
  });
  registerToolbarHandler('awrit:select-review-recipient', toolbarContentsId, (event: Electron.IpcMainInvokeEvent, id: unknown) => {
    if (!terminalReview || !view.binding || event.sender !== toolbar.webContents || typeof id !== 'string') return false;
    const client = reviewRecipients.get(id);
    if (!client?.windowId || client.socket.destroyed || !getIpcServer()?.getClients().includes(client)) return false;
    view.binding.sourceWindowId = client.windowId;
    view.binding.clientSocket = client.socket;
    return true;
  });
  let terminalRefreshGeneration: string | undefined;
  let terminalRefreshCapture: string | undefined;
  let terminalRefreshBusy = false;
  let terminalRefreshQueued = false;
  let terminalRefreshTimeout: ReturnType<typeof setTimeout> | undefined;
  const requestTerminalRefresh = async () => {
    if (!terminalReview || isDestroyed() || !view.designMode) return;
    if (terminalRefreshBusy) { terminalRefreshQueued = true; return; }
    terminalRefreshBusy = true;
    terminalRefreshGeneration = crypto.randomBytes(12).toString('hex');
    terminalRefreshTimeout = setTimeout(() => {
      terminalRefreshQueued = false;
      finishTerminalRefresh();
      console_.error('Terminal refresh timed out; keeping the current review.');
    }, 15000);
    try {
      await toolbar.webContents.executeJavaScript(`new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Review save timed out')), 1500); window.dispatchEvent(new CustomEvent('awrit:save-review-for-resize', {detail: {resolve: () => { clearTimeout(timer); resolve(); }, reject: error => { clearTimeout(timer); reject(error); }}})); })`);
      if (!isDestroyed() && view.designMode && terminalRefreshGeneration) {
        const requestPath = `${terminalReview.imagePath}.refresh`;
        fs.writeFileSync(`${requestPath}.next`, terminalRefreshGeneration, { mode: 0o600 });
        fs.renameSync(`${requestPath}.next`, requestPath);
      } else { terminalRefreshQueued = false; finishTerminalRefresh(); }
    } catch (error) {
      terminalRefreshQueued = false;
      finishTerminalRefresh();
      console_.error('Could not save review before resizing:', error);
    }
  };
  const finishTerminalRefresh = () => {
    terminalRefreshBusy = false;
    terminalRefreshGeneration = undefined;
    terminalRefreshCapture = undefined;
    if (terminalRefreshTimeout !== undefined) clearTimeout(terminalRefreshTimeout);
    if (terminalRefreshQueued) { terminalRefreshQueued = false; void requestTerminalRefresh(); }
  };
  const initializeTerminalReview = () => {
    if (!terminalReview) return;
    // The owner logs separately from the helper's stderr. Keep a per-review
    // stage beside its capture so timeout errors identify the stalled boundary.
    const startupStage = (stage: string) => {
      try { fs.writeFileSync(`${terminalReview.imagePath}.startup`, stage, { mode: 0o600 }); }
      catch (error) { console_.error('Could not record native review startup stage:', error); }
    };
    startupStage('reading capture');
    listen('awrit:design-frame-ready', (event: Electron.IpcMainEvent, captureId: unknown) => {
      if (event.sender !== toolbar.webContents || !view.designMode || typeof captureId !== 'string' || captureId !== getCaptureMeta()?.captureId) return;
      const generation = terminalRefreshGeneration;
      if (generation && captureId !== terminalRefreshCapture) return;
      if (!generation) startupStage('waiting for first paint');
      toolbar.webContents.once('paint', () => {
        if (isDestroyed() || !view.designMode || getCaptureMeta()?.captureId !== captureId || terminalRefreshGeneration !== generation) return;
        out.write('\x1bP@kitty-overlay-ready|\x1b\\');
        const readyPath = `${terminalReview.imagePath}.ready`;
        fs.writeFileSync(`${readyPath}.next`, generation ?? '', { mode: 0o600 });
        fs.renameSync(`${readyPath}.next`, readyPath);
        if (!generation) startupStage('ready');
      });
      toolbar.webContents.invalidate();
    });
    const updatedPath = `${terminalReview.imagePath}.updated`;
    const watcher = fs.watch(path.dirname(terminalReview.imagePath), async (_event, filename) => {
      const errorPath = `${terminalReview.imagePath}.error`;
      if (fs.existsSync(errorPath)) {
        const [generation, ...message] = fs.readFileSync(errorPath, 'utf8').split('\n');
        fs.rmSync(errorPath, { force: true });
        if (generation === terminalRefreshGeneration) {
          fs.rmSync(updatedPath, { force: true });
          terminalRefreshQueued = false;
          console_.error('Could not recapture terminal:', message.join('\n'));
          finishTerminalRefresh();
        }
        return;
      }
      const donePath = `${terminalReview.imagePath}.done`;
      if (fs.existsSync(donePath)) {
        const generation = fs.readFileSync(donePath, 'utf8');
        fs.rmSync(donePath, { force: true });
        if (generation === terminalRefreshGeneration) finishTerminalRefresh();
        return;
      }
      if ((filename !== null && filename !== path.basename(updatedPath)) || !fs.existsSync(updatedPath)) return;
      const generation = fs.readFileSync(updatedPath, 'utf8');
      fs.rmSync(updatedPath, { force: true });
      if (generation !== terminalRefreshGeneration) return;
      try {
        if (isDestroyed() || !view.designMode) return;
        const png = readTerminalCapture(terminalReview.imagePath);
        const captureId = `cap-${crypto.randomBytes(6).toString('hex')}`;
        terminalRefreshCapture = captureId;
        saveReviewCapture(png, captureId, { kind: 'terminal', windowId: terminalReview.windowId });
        await openReviewSession({ sender: toolbar.webContents }, captureId);
      } catch (error) {
        console_.error('Could not refresh terminal review:', error);
        terminalRefreshQueued = false;
        finishTerminalRefresh();
      }
    });
    toolbar.once('closed', () => {
      watcher.close();
      if (terminalRefreshTimeout !== undefined) clearTimeout(terminalRefreshTimeout);
    });
    const png = readTerminalCapture(terminalReview.imagePath);
    const image = nativeImage.createFromBuffer(png);
    if (image.isEmpty()) throw new Error('Invalid terminal capture PNG');
    const captureId = `cap-${crypto.randomBytes(6).toString('hex')}`;
    saveReviewCapture(png, captureId, { kind: 'terminal', windowId: terminalReview.windowId });
    startupStage('loading toolbar');
    let toolbarLoadFailed = false;
    toolbar.webContents.once('did-fail-load', (_event, code, _description, _url, isMainFrame) => {
      if (isMainFrame) {
        toolbarLoadFailed = true;
        startupStage(`toolbar load failed (${code})`);
      }
    });
    loadToolbarContent();
    const activate = () => {
      if (toolbarLoadFailed) return;
      startupStage('waiting for decoded frame');
      void openReviewSession({ sender: toolbar.webContents }, captureId).catch(error => {
        startupStage('could not open review');
        console_.error('Native review startup: could not open review:', error);
      });
    };
    if (toolbar.webContents.isLoading()) toolbar.webContents.once('did-finish-load', activate);
    else activate();
  };
  registerToolbarHandler('awrit:save-design-draft', toolbarContentsId, onSaveDesignDraft);
  registerToolbarHandler(
    'awrit:send-design-feedback',
    toolbarContentsId,
    onSendDesignFeedback,
  );
  return { requestTerminalRefresh, initializeTerminalReview };
}
