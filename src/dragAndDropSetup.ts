export function setupDragAndDrop(webContents: Electron.WebContents) {
  try {
    const dbg = webContents.debugger;
    if (!dbg.isAttached()) {
      dbg.attach('1.3');
    }
    dbg.sendCommand('Input.setInterceptDrags', { enabled: true }).catch(() => {});

    dbg.on('message', (_event, method, params) => {
      if (method === 'Input.dragIntercepted') {
        // @ts-expect-error
        webContents.currentDragData = params.data;
        // @ts-expect-error
        const pos = webContents.lastMousePos || { x: 0, y: 0 };
        const zoom = webContents.getZoomFactor();
        dbg
          .sendCommand('Input.dispatchDragEvent', {
            type: 'dragEnter',
            x: pos.x / zoom,
            y: pos.y / zoom,
            data: params.data,
            modifiers: pos.modifiers || 0,
          })
          .catch(() => {});
      }
    });
  } catch (_e) {}
}
