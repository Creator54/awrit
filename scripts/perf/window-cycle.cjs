// Plain Electron control: no Awrit code, sandbox/GPU defaults unchanged.
const { app, BrowserWindow } = require('electron');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cycles = Number(process.env.AWRIT_SOAK_CYCLES || 60);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const make = async () => {
    const window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { offscreen: true } });
    let painted;
    const frame = new Promise((resolve) => { painted = resolve; });
    window.webContents.on('paint', () => painted());
    await window.loadURL('data:text/html,<body style="background:darkgreen;color:white"><h1>Resource cycle</h1>');
    await frame;
    return window;
  };
  const keeper = await make();
  await sleep(3000);
  console.log('SAMPLE 0');
  await sleep(1000);
  for (let cycle = 1; cycle <= cycles; cycle++) {
    const window = await make();
    await sleep(200);
    window.destroy();
    await sleep(200);
    if (cycle % 10 === 0 || cycle === cycles) {
      await sleep(2000);
      console.log(`SAMPLE ${cycle}`);
      await sleep(1000);
    }
  }
  await sleep(10000);
  console.log('SAMPLE idle');
  await sleep(1000);
  keeper.destroy();
  app.quit();
}).catch((error) => { console.error(error); app.exit(1); });
