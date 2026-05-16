/** Homepage
 * The page that's displayed by default when no URL is provided
 **/
const homepage = 'https://google.com';

/** URL Bar Configuration
 * Controls the visibility and toggle behavior of the URL bar
 **/
const urlBar = {
  /** Show URL bar by default on startup */
  defaultVisible: true,
  /** Keybind to toggle URL bar visibility */
  toggleKey: '<A-u>',
};

/** Profile Configuration
 * Path to user data directory for cookies, sessions, extensions
 * Set to null to use default Electron profile location
 * Can be overridden via AWRIT_PROFILE environment variable
 **/
const profile = process.env.AWRIT_PROFILE || null;

/** Debug Port
 * Port for remote debugging (CDP) - for programmatic control
 * External clients can connect to ws://localhost:<port>/devtools/...
 **/
const debugPort = 9222;

/** Google OAuth Configuration
 * Required for system browser OAuth flows
 **/
const oauth = {
  /** Google Client ID from Cloud Console */
  clientId: '',
  /** OAuth Scopes */
  scopes: ['email', 'profile'],
  /** Local port for loopback redirect server */
  redirectPort: 9223,
};

/** Kitty Integration
 * Configuration for running awrit in Kitty terminal splits
 **/
const kitty = {
  /** Run with hold to keep terminal open */
  hold: false,
  /** Close on Ctrl+C (set to false to disable default quit) */
  quitOnCtrlC: true,
  /** Character cell size for mouse coordinate conversion
   * Adjust these based on your terminal font size
   * width: width of each character in pixels
   * height: height of each character in pixels
   */
  cellSize: {
    width: 8,
    height: 20,
  },
  /** Terminal padding/margin offset (in pixels)
   * Matches Kitty's window_padding_width setting (30px in this config)
   */
  padding: {
    x: 30,
    y: 30,
  },
};

/** Keybindings
 *
 * @typedef {import('./src/keybindings').KeyBindingAction} KeyBindingAction
 */

/**
 * Keybindings configuration object that maps Neovim-style key sequences to actions.
 *
 * Keybinding Format:
 * - Single key: "a", "b", "1", etc.
 * - Special keys: "<Tab>", "<Enter>", etc.
 * - Modifiers:
 *   - <C-...> for Ctrl (e.g., <C-s> for Ctrl+S)
 *   - <A-...> for Alt
 *   - <S-...> for Shift
 *   - <M-...> for Meta/Command
 * - Multiple modifiers can be combined: <C-A-s> for Ctrl+Alt+S
 * - Multi-key sequences: <C-w>l for Ctrl+W followed by L
 *
 * Behavior:
 * - Single-key bindings execute immediately
 * - Multi-key bindings match exact sequences
 * - Modifier order is handled consistently (e.g., <C-A-s> matches both Ctrl+Alt+S and Alt+Ctrl+S)
 * - When a key sequence is a prefix of another binding:
 *   - The system waits for a timeout period
 *   - If the longer sequence is completed within the timeout, it executes
 *   - If no further keys are pressed within the timeout, the shorter binding executes
 *
 * Example:
 * ```js
 * {
 *   // Executes after timeout if no longer sequence
 *   '<C-a>': () => console.log('Select all'),
 *   // Executes after timeout if no longer sequence
 *   '<C-w>': () => console.log('Close window'),
 *   // Executes immediately if pressed within timeout
 *   '<C-w>l': () => console.log('Next window'),
 * }
 * ```
 *
 * @type {Record<string, KeyBindingAction> & {
 *   mac?: Record<string, KeyBindingAction>,
 *   linux?: Record<string, KeyBindingAction>
 * }}
 */
const keybindings = {
  mac: {
    '<M-c>': copy,
    '<M-C>': copy,
    '<M-v>': paste,
    '<M-V>': paste,
    '<M-q>': quit,
    '<M-Q>': quit,
    '<M-d>': quit,
    '<M-w>': quit,
    '<M-a>': ({ view }) => {
      view.focusedContent.selectAll();
    },
    '<M-]>': forward,
    '<M-[>': back,
    '<M-f>': find,
    '<M-r>': refresh,
  },
  linux: {
    '<C-c>': copy,
    '<C-S-v>': paste, // standard terminal paste
    '<C-S-V>': paste, // uppercase V variant just in case
    '<C-q>': quit,
    '<C-d>': quit,
    '<C-]>': forward,
    '<C-[>': back,
    '<C-f>': find,
    '<C-r>': refresh,
  },
  '<Mouse4>': back,
  '<Mouse5>': forward,
};

/** @type {KeyBindingAction} */
function back({ view }) {
  view.back();
}

/** @type {KeyBindingAction} */
function forward({ view }) {
  view.forward();
}

/** @type {KeyBindingAction} */
function refresh({ view }) {
  view.refresh();
}

function find({ view }) {
  view.toolbar.webContents.send('toolbar:toggle-find');
  view.content.blurWebView();
  view.toolbar.focusOnWebView();
  view.focusedContent = view.toolbar.webContents;
}

const { exec } = require('child_process');
const electron = require('electron');

// Clipboard timeout to prevent blocking (execSync causes freeze if xclip hangs)
const CLIPBOARD_TIMEOUT_MS = 500;

/**
 * Execute a command with timeout protection
 * Returns stdout or null on failure/timeout
 */
function execWithTimeout(cmd, input, timeoutMs = CLIPBOARD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const child = exec(cmd, { encoding: 'utf8', timeout: timeoutMs }, (err, stdout) => {
      if (err) {
        resolve(null);
      } else {
        resolve(stdout);
      }
    });
    if (input) {
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

/**
 * Write text to system clipboard
 * Uses Electron clipboard (fast, non-blocking) with native fallback
 */
async function writeToSystemClipboard(text) {
  try {
    // Primary: Electron clipboard (fast, non-blocking)
    electron.clipboard.writeText(text);
  } catch (e) {
    // Fallback: native clipboard with timeout
    try {
      if (process.platform === 'darwin') {
        await execWithTimeout('pbcopy', text);
      } else if (process.platform === 'linux') {
        if (process.env.WAYLAND_DISPLAY) {
          await execWithTimeout('wl-copy', text);
        } else {
          await execWithTimeout('xclip -selection clipboard', text);
        }
      } else if (process.platform === 'win32') {
        await execWithTimeout('clip', text);
      }
    } catch (nativeErr) {
      console.error('[Clipboard] Copy failed:', nativeErr.message);
    }
  }
}

/**
 * Read text from system clipboard
 * Uses Electron clipboard (fast, non-blocking) with native fallback
 */
async function readFromSystemClipboard() {
  try {
    // Primary: Electron clipboard (fast, non-blocking)
    const text = electron.clipboard.readText();
    if (text) return text;
  } catch (e) {
    // Continue to fallback
  }
  
  // Fallback: native clipboard with timeout
  try {
    let result;
    if (process.platform === 'darwin') {
      result = await execWithTimeout('pbpaste', null);
    } else if (process.platform === 'linux') {
      if (process.env.WAYLAND_DISPLAY) {
        result = await execWithTimeout('wl-paste', null);
      } else {
        result = await execWithTimeout('xclip -selection clipboard -o', null);
      }
    } else if (process.platform === 'win32') {
      result = await execWithTimeout('powershell Get-Clipboard', null);
    }
    return result || '';
  } catch (e) {
    console.error('[Clipboard] Paste failed:', e.message);
  }
  return '';
}

/** @type {KeyBindingAction} */
function copy({ view }) {
  view.focusedContent
    .executeJavaScript(`(() => {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
        return activeEl.value.substring(activeEl.selectionStart, activeEl.selectionEnd);
      }
      return window.getSelection().toString();
    })()`)
    .then((selectedText) => {
      if (selectedText) {
        // writeToSystemClipboard is async but we don't need to await
        // this prevents blocking the event loop
        writeToSystemClipboard(selectedText).catch((err) => {
          console.error('[Clipboard] Write failed:', err);
        });
      }
    })
    .catch((err) => {
      console.error('[Action] Copy failed:', err);
    });
}

/** @type {KeyBindingAction} */
function paste({ view }) {
  // readFromSystemClipboard is async, use .then() to avoid blocking
  readFromSystemClipboard().then((text) => {
    if (text) {
      view.focusedContent.insertText(text);
    }
  }).catch((err) => {
    console.error('[Clipboard] Read failed:', err);
  });
}

/** @type {KeyBindingAction} */
function quit() {
  process.emit('SIGINT');
}

/** @type {KeyBindingAction} */
let _urlBarHidden = false;
function toggleUrlBar({ view }) {
  _urlBarHidden = !_urlBarHidden;
  view.toolbar.webContents.send('toolbar:toggle-url-bar');
  view.toolbarNode.height = _urlBarHidden ? { value: 0, unit: 'px' } : { value: 40, unit: 'px' };
  view.relayout();
}

const config = {
  homepage,
  keybindings: {
    ...keybindings,
    linux: {
      ...keybindings.linux,
      '<A-u>': toggleUrlBar,
    },
    mac: {
      ...keybindings.mac,
      '<M-u>': toggleUrlBar,
    },
  },
  urlBar,
  profile,
  debugPort,
  oauth,
  kitty,
};

module.exports = config;

/** Utilities */

const util = require('node:util');

function debug(...args) {
  process.stderr.write(
    util
      .formatWithOptions(
        {
          colors: true,
        },
        ...args,
      )
      .replaceAll('\n', '\r\n'),
  );
}
