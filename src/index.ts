import { app, dialog, ipcMain } from 'electron';
import {
  termEnableFeatures,
  listenForInput,
  type TermEvent,
  termDisableFeatures,
  getWindowSize,
} from 'awrit-native-rs';
import * as out from './tty/output';
import { handleInput } from './inputHandler';
import { createWindowWithToolbar, type WindowView } from './windows';
import { console_ } from './console';
import { options } from './args';
import { features } from './features';
import { clearPlacements } from './tty/kittyGraphics';
import { loadKeyBindings } from './keybindings';
import fs from 'node:fs';
import path from 'node:path';

let homepage = 'https://github.com/chase/awrit';

function loadConfig(config: typeof import('../config.js')) {
  if (config.homepage) homepage = config.homepage;
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
    const topLevelKeys = ['<C-c>', '<Mouse4>', '<Mouse5>'];
    for (const key of topLevelKeys) {
      if ((config.keybindings as any)[key]) {
        bindings[key] = (config.keybindings as any)[key];
      }
    }
    // Add default system keybindings
    bindings['<C-b>'] = ({ view }: { view?: WindowView }) => view?.toggleUrlBar();

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
}

const CONFIG_PATH = '../config.js';
const CONFIG_PATH_RESOLVED = path.resolve(__dirname, CONFIG_PATH);
loadConfig(require(CONFIG_PATH_RESOLVED));

fs.watchFile(CONFIG_PATH_RESOLVED, { interval: 200 }, (curr, prev) => {
  if (curr.mtime <= prev.mtime) return;
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
});

// Don't show a dialog box on uncaught errors
dialog.showErrorBox = (title, content) => {
  console_.error(title, content);
};

const INITIAL_URL = options.url || homepage;

// Handle --toggle-url-bar CLI argument
let urlBarVisible = true;
if (options['toggle-url-bar'] === true) {
  urlBarVisible = false;
}

// Export for use in windows.ts
(globalThis as any).__AWRIT_URL_BAR_VISIBLE__ = urlBarVisible;

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
  if (
    evt.eventType === 'key' &&
    evt.keyEvent.code === 'd' &&
    evt.keyEvent.modifiers.includes('ctrl')
  ) {
    cleanup(0);
  }

  // Graphics protocol events now come through graphics events
  if (options['debug-paint'] && evt.eventType === 'graphics') {
    console_.error('Graphics protocol: ', evt.graphics);
  }

  handleInput(evt);
}

function setup() {
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

setup();

// Disable Electron's stdout logging
app.commandLine.appendSwitch('log-level', '0');
app.commandLine.appendSwitch('disable-logging');
// Disable Chrome DevTools logging
app.commandLine.appendSwitch('silent-debugger-extension-api');

// Prevent sysctlbyname crash: https://github.com/electron/electron/issues/45653#issuecomment-2663510200
app.commandLine.appendSwitch('disable-features', 'UseBrowserCalculatedOrigin');

// Enable remote debugging port for programmatic control
app.commandLine.appendSwitch('remote-debugging-port', '9222');
// Allow remote connections (for external CDP clients)
app.commandLine.appendSwitch('remote-allow-origins', '*');

app.whenReady().then(async () => {
  const window = await createWindowWithToolbar(getWindowSize(), INITIAL_URL);

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
