import { debuggerManager } from './browserOwner/debugger.js';

type OpenProperty = 'openFile' | 'openDirectory' | 'multiSelections';

function dialogProperties(mode: unknown, directory: boolean): OpenProperty[] {
  if (directory) return ['openDirectory'];
  if (mode === 'selectMultiple') return ['openFile', 'multiSelections'];
  return ['openFile'];
}

/**
 * Offscreen pages have no real window, so Chromium's own file chooser crashes on
 * Wayland when it tries to export one. Take over file inputs and answer them with
 * a parentless native dialog instead. Folder pickers (`showDirectoryPicker`)
 * carry no input node; Chromium cancels them, which the page sees as AbortError.
 */
export function setupFileChooser(
  webContents: Electron.WebContents,
  showOpenDialog: (
    options: Electron.OpenDialogOptions,
    signal: AbortSignal,
    install: (file: string) => Promise<void>,
  ) => Promise<Electron.OpenDialogReturnValue>,
  onUnavailable?: () => void,
  retainSelectionSignals = false,
): () => void {
  let lease: ReturnType<typeof debuggerManager.acquire>;
  try {
    lease = debuggerManager.acquire(webContents);
  } catch (error) {
    console.error('File chooser debugger unavailable:', error);
    onUnavailable?.();
    return () => {};
  }
  let stopped = false;
  void lease
    .sendCommand('Page.enable')
    .then(() => {
      if (stopped || webContents.isDestroyed()) return;
      return lease.sendCommand('Page.setInterceptFileChooserDialog', { enabled: true });
    })
    .catch((error) => {
      if (stopped || webContents.isDestroyed()) return;
      console.error('File chooser interception failed:', error);
      onUnavailable?.();
    });

  // One dialog at a time, including an aborted native dialog until its caller settles:
  // Electron cannot dismiss showOpenDialog, so releasing the guard early could flood the desktop.
  let dialogOpen = false;
  const documentChoosers = new Set<AbortController>();
  const cancelPending = (
    _event?: unknown,
    _url?: string,
    isInPlace = false,
    isMainFrame = true,
  ) => {
    if (isInPlace || !isMainFrame) return;
    for (const controller of documentChoosers) controller.abort();
    documentChoosers.clear();
  };
  webContents.on('did-start-navigation', cancelPending);
  webContents.on('destroyed', cancelPending);
  const unsubscribe = lease.onMessage('Page.fileChooserOpened', (params) => {
    const backendNodeId = params.backendNodeId;
    if (typeof backendNodeId !== 'number' || dialogOpen || stopped) return;
    dialogOpen = true;
    const controller = new AbortController();
    documentChoosers.add(controller);
    let installed = false;
    const install = async (files: string[]) => {
      if (controller.signal.aborted || stopped || webContents.isDestroyed())
        throw new Error('File chooser canceled');
      await lease.sendCommand('DOM.setFileInputFiles', { files, backendNodeId });
      if (controller.signal.aborted || stopped) throw new Error('File chooser canceled');
      installed = true;
    };
    void (async () => {
      if (controller.signal.aborted) return { canceled: true, filePaths: [] };
      const description = await lease.sendCommand('DOM.describeNode', { backendNodeId });
      const node = typeof description === 'object' && description !== null && 'node' in description ? description.node : undefined;
      const attributes: unknown = typeof node === 'object' && node !== null && 'attributes' in node ? node.attributes : undefined;
      const directory = Array.isArray(attributes) && attributes.some(
        (attribute, index) => index % 2 === 0 && attribute === 'webkitdirectory',
      );
      const acceptIndex = Array.isArray(attributes) ? attributes.findIndex(
        (attribute, index) => index % 2 === 0 && attribute === 'accept',
      ) : -1;
      const accept = acceptIndex >= 0 && Array.isArray(attributes) ? attributes[acceptIndex + 1] : undefined;
      const types = typeof accept === 'string' ? accept.split(',').map(type => type.trim().toLowerCase()) : [];
      // Mixed MIME/extension lists stay unfiltered rather than hiding valid MIME matches.
      const extensions = !directory && types.length > 0 && types.every(type => /^\.[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(type))
        ? [...new Set(types.map(type => type.slice(1)))] : [];
      if (controller.signal.aborted || stopped) return { canceled: true, filePaths: [] };
      return showOpenDialog(
        {
          properties: dialogProperties(params.mode, directory),
          ...(extensions.length ? { filters: [
            { name: 'Accepted files', extensions },
            { name: 'All files', extensions: ['*'] },
          ] } : {}),
        },
        controller.signal,
        (file) => install([file]),
      );
    })()
      .then((result) => {
        if (controller.signal.aborted || result.canceled || result.filePaths.length === 0) return;
        return install(result.filePaths);
      })
      .catch((error) => {
        if (!controller.signal.aborted && !stopped) console.error('File chooser failed:', error);
      })
      .finally(() => {
        // Successful selections retain their signal through document lifetime:
        // Chromium reads selected files lazily, not just during installation.
        if (!installed || !retainSelectionSignals) documentChoosers.delete(controller);
        dialogOpen = false;
      });
  });

  return () => {
    if (stopped) return;
    stopped = true;
    cancelPending();
    webContents.off('did-start-navigation', cancelPending);
    webContents.off('destroyed', cancelPending);
    unsubscribe();
    void lease
      .sendCommand('Page.setInterceptFileChooserDialog', { enabled: false })
      .catch(() => {});
    lease.release();
  };
}
