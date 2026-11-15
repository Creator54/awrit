import { debuggerManager } from './browserOwner/debugger.js';

export function setupDragAndDrop(webContents: Electron.WebContents): () => void {
  let lease: ReturnType<typeof debuggerManager.acquire>;
  try {
    lease = debuggerManager.acquire(webContents);
    void lease.sendCommand('Input.setInterceptDrags', { enabled: true }).catch(() => {});
  } catch {
    return () => {};
  }

  const unsubscribe = lease.onMessage('Input.dragIntercepted', (params) => {
    // @ts-expect-error
    webContents.currentDragData = params.data;
    // @ts-expect-error
    const pos = webContents.lastMousePos || { x: 0, y: 0 };
    const zoom = webContents.getZoomFactor();
    void lease
      .sendCommand('Input.dispatchDragEvent', {
        type: 'dragEnter',
        x: pos.x / zoom,
        y: pos.y / zoom,
        data: params.data,
        modifiers: pos.modifiers || 0,
      })
      .catch(() => {});
  });

  return () => {
    unsubscribe();
    lease.release();
  };
}
