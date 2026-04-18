const { app, BrowserWindow, clipboard } = require('electron');

app.whenReady().then(() => {
  const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  win.loadURL('data:text/html,<body><input id="test" type="text" value="Hello Input" autofocus><script>const el = document.getElementById("test"); el.focus(); el.setSelectionRange(0, 5);</script></body>');
  
  win.webContents.on('did-finish-load', () => {
    setTimeout(async () => {
      clipboard.writeText('');
      const selectedText = await win.webContents.executeJavaScript(`(() => {
        const activeEl = document.activeElement;
        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
          return activeEl.value.substring(activeEl.selectionStart, activeEl.selectionEnd);
        }
        return window.getSelection().toString();
      })()`);
      
      if (selectedText) {
        clipboard.writeText(selectedText);
      }
      
      setTimeout(async () => {
        console.log('Input value after copy:', clipboard.readText());
        app.quit();
      }, 500);
    }, 1000);
  });
});
