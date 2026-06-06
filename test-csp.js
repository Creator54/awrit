const { app, BrowserWindow } = require('electron');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    webPreferences: {
      contextIsolation: true,
      preload: __dirname + '/test-preload.js'
    }
  });
  win.loadURL('data:text/html;charset=utf-8,<meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'none\'"><body><h1>CSP Test</h1><script>console.log("This should be blocked")</script></body>');
});
