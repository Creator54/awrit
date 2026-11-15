import fs from 'node:fs';
import path from 'node:path';
import { ipcMain, type WebContents } from 'electron';
import { debuggerManager } from './browserOwner/debugger.js';
import { clearGrants, grantFolder } from './folderGrants.js';

const CHANNEL = 'awrit:pick-folder';

/** One picker per page; removed when the page goes away. */
const pickers = new Map<number, () => Promise<{ ok: boolean }>>();

let ipcRegistered = false;
function ensureIpc(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;
  ipcMain.handle(CHANNEL, async (event): Promise<{ ok: boolean }> => {
    const pick = pickers.get(event.sender.id);
    return pick ? pick() : { ok: false };
  });
}

/**
 * Answers `showDirectoryPicker` with the platform folder dialog.
 *
 * Offscreen pages get no Chromium picker (it is cancelled and the page sees AbortError), so
 * the page's own call is replaced by one that asks the main process for the dialog. The
 * chosen folder is then dropped on the page synthetically, which mints the
 * FileSystemDirectoryHandle the File System Access API requires.
 */
export function setupFolderPicker(
  webContents: WebContents,
  showOpenDialog: (options: Electron.OpenDialogOptions) => Promise<Electron.OpenDialogReturnValue>,
): () => void {
  let lease: ReturnType<typeof debuggerManager.acquire>;
  try {
    lease = debuggerManager.acquire(webContents);
  } catch {
    return () => {};
  }
  ensureIpc();

  const pageId = webContents.id;
  let stopped = false;

  const pick = async (): Promise<{ ok: boolean }> => {
    const result = await showOpenDialog({ properties: ['openDirectory'] });
    const folder = result.filePaths[0];
    if (stopped || webContents.isDestroyed() || result.canceled || !folder) return { ok: false };
    const resolved = path.resolve(folder);
    if (!fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory()) return { ok: false };
    grantFolder(pageId, webContents.getURL(), resolved);
    const data = { items: [], files: [resolved], dragOperationsMask: 1 };
    // Answer first and drop next, so the page is already waiting for the folder.
    setTimeout(() => {
      void (async () => {
        for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
          await lease.sendCommand('Input.dispatchDragEvent', { type, x: 1, y: 1, data });
        }
      })().catch(() => {});
    }, 50);
    return { ok: true };
  };
  pickers.set(pageId, pick);

  const install = () => {
    if (stopped || webContents.isDestroyed()) return;
    void webContents.executeJavaScript(PICKER_SCRIPT).catch(() => {});
  };
  const onNavigation = (_event: unknown, url: string, inPlace?: boolean, isMainFrame?: boolean) => {
    if (!inPlace && isMainFrame !== false && !url.startsWith('about:')) clearGrants(pageId);
  };
  webContents.on('did-finish-load', install);
  webContents.on('did-start-navigation', onNavigation);

  return () => {
    if (stopped) return;
    stopped = true;
    pickers.delete(pageId);
    clearGrants(pageId);
    webContents.off('did-finish-load', install);
    webContents.off('did-start-navigation', onNavigation);
    lease.release();
  };
}

/**
 * Runs in the page. Replaces `showDirectoryPicker` with a main-process dialog, and turns the
 * dropped folder into the handle the API normally returns.
 */
const PICKER_SCRIPT = `(() => {
  if (window.__awritFolderPicker) return;
  window.__awritFolderPicker = true;
  Object.defineProperty(window, 'showDirectoryPicker', {
    configurable: true,
    writable: true,
    value: () => new Promise((resolve, reject) => {
      const layer = document.createElement('div');
      layer.style.cssText = 'position:fixed;inset:0;z-index:2147483647';
      const swallow = (event) => { event.preventDefault(); event.stopPropagation(); };
      const finish = (error) => {
        layer.remove();
        if (error) reject(error);
      };
      layer.addEventListener('dragover', swallow, true);
      layer.addEventListener('drop', (event) => {
        swallow(event);
        const item = event.dataTransfer.items[0];
        if (!item) return finish(new Error('No folder'));
        item.getAsFileSystemHandle().then(handle => {
          if (!handle) return finish(new Error('No folder'));
          finish();
          resolve(handle);
        }, finish);
      }, true);
      document.documentElement.append(layer);
      window.awrit.pickFolder().then(result => {
        if (!result.ok) finish(new DOMException('The user aborted a request.', 'AbortError'));
      }, finish);
    }),
  });
})()`;
