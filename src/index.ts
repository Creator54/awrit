import * as out from './tty/output';
import fs from 'node:fs';
import path from 'node:path';
import { options } from './args';

// Only redirect console logs, NOT process.stdout/stderr (which are needed for graphics)
if (!options.dev) {
  const logFile = path.join(process.cwd(), 'awrit_startup.log');
  const logStream = fs.createWriteStream(logFile, { flags: 'a' });
  console.log = (...args) => logStream.write(args.join(' ') + '\n');
  console.error = (...args) => logStream.write(args.join(' ') + '\n');
}

out.setup();

import { app, dialog, ipcMain, nativeTheme, Menu } from 'electron';
import {
  termEnableFeatures,
  listenForInput,
  type TermEvent,
  termDisableFeatures,
} from 'awrit-native-rs';
import { handleDeepLinkAuth } from './auth';
import { sessionPromise } from './session';

process.on('uncaughtException', (err) => {
  const logStream = fs.createWriteStream(path.join(process.cwd(), 'awrit_startup.log'), { flags: 'a' });
  logStream.write(`UNCAUGHT EXCEPTION: ${err.message}\n${err.stack}\n`);
});

process.on('unhandledRejection', (reason, promise) => {
  const logStream = fs.createWriteStream(path.join(process.cwd(), 'awrit_startup.log'), { flags: 'a' });
  logStream.write(`UNHANDLED REJECTION: ${reason}\n`);
});

import { handleInput } from './inputHandler';
import { createWindowWithToolbar, getWindowSize, type WindowView } from './windows';
import { console_ } from './console';
import { features } from './features';
import { clearPlacements } from './tty/kittyGraphics';
import { loadKeyBindings } from './keybindings';

let homepage = 'https://github.com/chase/awrit';
let urlBarDefaultVisible = false;

function loadConfig(config: typeof import('../config.js')) {
  if (config.homepage) homepage = config.homepage;
  if (config.urlBar && typeof config.urlBar.defaultVisible === 'boolean') {
    urlBarDefaultVisible = config.urlBar.defaultVisible;
  }
  if (config.keybindings) {
    // Create a clean keybindings object for loadKeyBindings
    const bindings: Record<string, any> = {};
    if (process.platform === 'darwin') {
      if (config.keybindings.mac) {
        Object.assign(bindings, config.keybindings.mac);
      }
    } else {
      if (config.keybindings.linux) {
        Object.assign(bindings, config.keybindings.linux);
      }
    }
    // Add common keybindings that exist at top level
    const topLevelKeys = ['<Mouse4>', '<Mouse5>'];
    for (const key of topLevelKeys) {
      if ((config.keybindings as any)[key]) {
        bindings[key] = (config.keybindings as any)[key];
      }
    }
    // Add default system keybindings
    const toggleKey = config.urlBar?.toggleKey || '<C-l>';
    bindings[toggleKey] = ({ view }: { view?: WindowView }) => view?.toggleOmnibox();

    loadKeyBindings({ keybindings: bindings });
  }
  if (config.profile !== undefined) {
    const { loadSessionConfig } = require('./session');
    loadSessionConfig({ profile: config.profile });
  }
  // Load kitty config for mouse coordinate mapping
  if (config.kitty?.cellSize) {
    const { setCellSize, setCellPadding } = require('./inputHandler');
    setCellSize(config.kitty.cellSize.width, config.kitty.cellSize.height);
    if (config.kitty.padding) {
      setCellPadding(config.kitty.padding.x, config.kitty.padding.y);
    }
  }
  if (config.auth) {
    const { registerProviders } = require('./authConfig');
    registerProviders(config.auth);
  }
}

const CONFIG_PATH = '../config.js';
const CONFIG_PATH_RESOLVED = path.resolve(__dirname, CONFIG_PATH);
loadConfig(require(CONFIG_PATH_RESOLVED));

// Watch config file for changes using inotify (event-driven, zero CPU when idle)
// instead of fs.watchFile which polls every 200ms
let configReloadTimeout: NodeJS.Timeout | null = null;
try {
  fs.watch(CONFIG_PATH_RESOLVED, (eventType) => {
    if (eventType !== 'change') return;
    // Debounce: editors often trigger multiple change events per save
    if (configReloadTimeout) clearTimeout(configReloadTimeout);
    configReloadTimeout = setTimeout(() => {
      configReloadTimeout = null;
      const oldConfig = require(CONFIG_PATH_RESOLVED);
      require.cache[CONFIG_PATH_RESOLVED] = undefined;

      try {
        const newConfig = require(CONFIG_PATH_RESOLVED);
        loadConfig(newConfig);
      } catch (e) {
        console_.error('Error loading config:', e);
        // Restore old config if new one fails
        try {
          loadConfig(oldConfig);
        } catch (e) {
          console_.error('Error restoring old config:', e);
        }
      }
    }, 300);
  });
} catch (e) {
  // Fallback to polling if fs.watch is not available (e.g., NFS mounts)
  fs.watchFile(CONFIG_PATH_RESOLVED, { interval: 1000 }, (curr, prev) => {
    if (curr.mtime <= prev.mtime) return;
    const oldConfig = require(CONFIG_PATH_RESOLVED);
    require.cache[CONFIG_PATH_RESOLVED] = undefined;
    try {
      const newConfig = require(CONFIG_PATH_RESOLVED);
      loadConfig(newConfig);
    } catch (e) {
      console_.error('Error loading config:', e);
      try { loadConfig(oldConfig); } catch (e) { console_.error('Error restoring old config:', e); }
    }
  });
}

// Don't show a dialog box on uncaught errors
dialog.showErrorBox = (title, content) => {
  console_.error(title, content);
};

const INITIAL_URL = options.url || homepage;



let exiting = false;
let quitListening = () => {};

const cleanup = (signum = 1, reason?: string) => {
  exiting = true;
  quitListening();
  clearPlacements();
  out.cleanup();
  if (features.current) {
    termDisableFeatures(features.current);
  }
  if (reason) {
    console_.log(reason);
  }
  process.exit(signum);
};

function inputHandler(evt: TermEvent) {
  // Graphics protocol events now come through graphics events
  if (options['debug-paint'] && evt.eventType === 'graphics') {
    console_.error('Graphics protocol: ', evt.graphics);
  }

  handleInput(evt);
}

function initializeTerminal() {
  const cleanup_ = () => cleanup();
  process.on('SIGINT', () => cleanup(0));
  process.on('SIGTERM', cleanup_);
  process.on('SIGABRT', cleanup_);

  out.setup();
  features.current = termEnableFeatures();
  const { keyboard, images } = features.current;
  if (!keyboard) {
    cleanup(1, 'Extended keyboard support is required');
  }
  if (!images) {
    cleanup(1, 'Basic Kitty graphics protocol support is required');
  }

  quitListening = listenForInput(inputHandler, 200);

  out.clearScreen();
  out.placeCursor({ x: 0, y: 0 });
}

initializeTerminal();



// Disable Electron's stdout logging
app.commandLine.appendSwitch('log-level', '0');
app.commandLine.appendSwitch('disable-logging');

// Memory optimizations for offscreen rendering
app.commandLine.appendSwitch('disable-gpu-compositing'); // No GPU needed for offscreen
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=256');

// Prevent sysctlbyname crash: https://github.com/electron/electron/issues/45653#issuecomment-2663510200
// Prevent navigator.webdriver = true and other automation indicators
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
// Disable features: UseBrowserCalculatedOrigin (crash fix) + HeadlessBrowser (Google detection)
app.commandLine.appendSwitch('disable-features', 'UseBrowserCalculatedOrigin,HeadlessBrowser');

// Enable remote debugging port for programmatic control (needed for MCP)
app.commandLine.appendSwitch('remote-debugging-port', '9222');

// Register awrit:// protocol for deep-linking (Generic Auth Bridge)
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('awrit', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('awrit');
}

// Single Instance Lock
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, commandLine) => {
    // Someone tried to run a second instance, we should focus our window.
    // Also handle deep links from the command line (Linux/Windows)
    const url = commandLine.pop();
    if (url && url.startsWith('awrit://')) {
      app.emit('open-url', new Event('open-url'), url);
    }
  });
}

app.on('window-all-closed', () => {
  cleanup(0);
});

// Disable default menu bar
Menu.setApplicationMenu(null);

app.whenReady().then(async () => {
  // Force dark mode for consistency with awrit UI
  nativeTheme.themeSource = 'dark';

  // Clear the screen again right before creating the window to wipe out 
  // any Electron startup logs that might have appeared during initialization.
  out.clearScreen();
  out.placeCursor({ x: 0, y: 0 });
  
  let size = getWindowSize();
  if (size.width === 0 || size.height === 0) {
    console_.error('Warning: Terminal reported 0x0 size, using fallback 800x600');
    size = { ...size, width: 800, height: 600 };
  }
  
  const window = await createWindowWithToolbar(size, INITIAL_URL, {
    urlBarVisible: urlBarDefaultVisible
  });

  // Handle deep-linking (e.g. awrit://auth-callback)
  app.on('open-url', async (_event, url) => {
    console_.log('Received deep link URL:', url);
    const session = await sessionPromise;
    await handleDeepLinkAuth(url, session);
  });

  // Check for deep link on startup (Linux/Windows)
  const startUrl = process.argv.find(arg => arg.startsWith('awrit://'));
  if (startUrl) {
    app.emit('open-url', new Event('open-url'), startUrl);
  }

  ipcMain.handle('findInPage', (_, text: string, opts) => {
    window.content.webContents.findInPage(text, opts);
  });

  ipcMain.handle('stopFindInPage', () => {
    window.content.webContents.stopFindInPage('clearSelection');
    window.toolbar.blurWebView();
    window.content.focusOnWebView();
    window.focusedContent = window.content.webContents;
  });
});
