/** Homepage
 * The page that's displayed by default when no URL is provided
 **/
const homepage = 'https://google.com';

/** URL Bar Configuration
 * Controls the visibility and toggle behavior of the URL bar
 **/
const urlBar = {
  /** Show URL bar by default on startup */
  defaultVisible: false,
  /** Keybind to toggle URL bar visibility */
  toggleKey: '<C-l>',
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

/** Secure Authentication Configuration
 * Required for system browser OAuth flows (bypasses "Insecure Browser" errors)
 **/
const auth = {
  /**
   * List of secure authentication providers.
   * When you visit a domain in the 'domains' list, awrit will open your
   * system browser to complete the login securely.
   **/
  providers: [
    {
      name: 'google',
      domains: ['accounts.google.com'],
      clientId: '1003228370782-652d92q21gcknh408dpb3fhfl927jnld.apps.googleusercontent.com', // Add your Google Client ID here to enable secure login
      redirectPort: 9223,
    },
  ],
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
/**
 * Helper to check if we should handle Vim navigation.
 * Active when no input is focused and no overlay is visible.
 */
function isVimNavigating({ view }) {
  const noInput = !view?.inputFocused;
  const noOverlay = !(view?.omniboxVisible || view?.findVisible || view?.keyHelpVisible);
  const shouldNavigate = noInput && noOverlay;

  if (process.env.AWRIT_DEBUG_VIM) {
    console.error('[VimNavDebug]', {
      inputFocused: view?.inputFocused,
      omnibox: view?.omniboxVisible,
      find: view?.findVisible,
      help: view?.keyHelpVisible,
      shouldNavigate
    });
  }

  return shouldNavigate;
}

/** @type {KeyBindingAction} */
function scrollDown({ view }) {
  if (!isVimNavigating({ view })) return false;
  view.content.webContents.executeJavaScript('window.scrollBy({ top: 100, behavior: "auto" })');
  return true;
}

/** @type {KeyBindingAction} */
function scrollUp({ view }) {
  if (!isVimNavigating({ view })) return false;
  view.content.webContents.executeJavaScript('window.scrollBy({ top: -100, behavior: "auto" })');
  return true;
}

/** @type {KeyBindingAction} */
function scrollLeft({ view }) {
  if (!isVimNavigating({ view })) return false;
  view.content.webContents.executeJavaScript('window.scrollBy({ left: -100, behavior: "auto" })');
  return true;
}

/** @type {KeyBindingAction} */
function scrollRight({ view }) {
  if (!isVimNavigating({ view })) return false;
  view.content.webContents.executeJavaScript('window.scrollBy({ left: 100, behavior: "auto" })');
  return true;
}

/** @type {KeyBindingAction} */
function scrollToTop({ view }) {
  if (!isVimNavigating({ view })) return false;
  view.content.webContents.executeJavaScript('window.scrollTo(0, 0)');
  return true;
}

/** @type {KeyBindingAction} */
function scrollToBottom({ view }) {
  if (!isVimNavigating({ view })) return false;
  // Use a very large number to ensure we hit the bottom regardless of height calculation quirks
  view.content.webContents.executeJavaScript('window.scrollTo(0, 10000000)');
  return true;
}

/** @type {KeyBindingAction} */
function scrollHalfPageDown({ view }) {
  if (!isVimNavigating({ view })) return false;
  view.content.webContents.executeJavaScript('window.scrollBy({ top: window.innerHeight / 2, behavior: "smooth" })');
  return true;
}

/** @type {KeyBindingAction} */
function scrollHalfPageUp({ view }) {
  if (!isVimNavigating({ view })) return false;
  view.content.webContents.executeJavaScript('window.scrollBy({ top: -window.innerHeight / 2, behavior: "smooth" })');
  return true;
}

/** @type {KeyBindingAction} */
function blurInput({ view }) {
  if (!view) return false;
  // If an overlay is visible, let ESC close it via normal handler
  if (view.omniboxVisible || view.findVisible || view.keyHelpVisible) return false;
  // Blur focused element so vim keys resume
  view.content.webContents.executeJavaScript(`
    if (document.activeElement && document.activeElement !== document.body && document.activeElement !== document.documentElement) {
      document.activeElement.blur();
    }
  `);
  return true;
}

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
    '<M-S-d>': toggleDarkMode,

    // Vim Navigation
    'j': scrollDown,
    'k': scrollUp,
    'h': scrollLeft,
    'l': scrollRight,
    'd': scrollHalfPageDown,
    'u': scrollHalfPageUp,
    'gg': scrollToTop,
    'G': scrollToBottom,
    'H': (args) => isVimNavigating(args) ? back(args) || true : false,
    'L': (args) => isVimNavigating(args) ? forward(args) || true : false,
    'r': (args) => isVimNavigating(args) ? refresh(args) || true : false,
    '<Esc>': blurInput,
    '<C-[>': blurInput,
    '/': (args) => isVimNavigating(args) ? find(args) || true : false,
    'n': (args) => isVimNavigating(args) ? (args.view?.findNext() || true) : false,
    'N': (args) => isVimNavigating(args) ? (args.view?.findPrev() || true) : false,
    'p': (args) => isVimNavigating(args) ? (args.view?.findPrev() || true) : false,
  },
  linux: {
    '<C-c>': copy,
    '<C-S-c>': copy,
    '<C-A-d>': diagnosticCopy,
    '<C-v>': paste,
    '<C-S-v>': paste, // standard terminal paste
    '<C-q>': quit,
    '<C-d>': quit,
    '<C-]>': forward,
    '<C-[>': back,
    '<A-left>': back,
    '<A-right>': forward,
    '<C-f>': find,
    '<C-r>': refresh,
    '<A-d>': toggleDarkMode,

    // Vim Navigation
    'j': scrollDown,
    'k': scrollUp,
    'h': scrollLeft,
    'l': scrollRight,
    'd': scrollHalfPageDown,
    'u': scrollHalfPageUp,
    'gg': scrollToTop,
    'G': scrollToBottom,
    'H': (args) => isVimNavigating(args) ? back(args) || true : false,
    'L': (args) => isVimNavigating(args) ? forward(args) || true : false,
    'r': (args) => isVimNavigating(args) ? refresh(args) || true : false,
    '<Esc>': blurInput,
    '<C-[>': blurInput,
    '/': (args) => isVimNavigating(args) ? find(args) || true : false,
    'n': (args) => isVimNavigating(args) ? (args.view?.findNext() || true) : false,
    'N': (args) => isVimNavigating(args) ? (args.view?.findPrev() || true) : false,
    'p': (args) => isVimNavigating(args) ? (args.view?.findPrev() || true) : false,
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
  if (process.env.AWRIT_DEBUG_VIM) console.error('[VimAction] Triggering find-in-page');
  view.toggleFind();
}

/** @type {KeyBindingAction} */
function toggleDarkMode({ view }) {
  view.toggleForceDark();
}

const { exec } = require('child_process');
const electron = require('electron');

// Clipboard timeout to prevent blocking (execSync causes freeze if xclip hangs)
const CLIPBOARD_TIMEOUT_MS = 500;

/**
 * Write text to the terminal emulator's clipboard using OSC 52.
 */
function writeToTerminalClipboard(text) {
  const base64 = Buffer.from(text).toString('base64');
  process.stdout.write(`\x1b]52;c;${base64}\x07`);
}

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
    
    // Secondary: Terminal OSC 52 (Robust over SSH/Wayland)
    writeToTerminalClipboard(text);
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
  if (!view) return;
  const target = view.focusedContent;
  
  // Use JavaScript extraction for more predictable behavior in offscreen mode
  const copyScript = `(() => {
    try {
      const activeEl = document.activeElement;
      if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
        return activeEl.value.substring(activeEl.selectionStart, activeEl.selectionEnd);
      }
      return window.getSelection().toString();
    } catch (e) {
      return '';
    }
  })()`;

  target
    .executeJavaScript(copyScript)
    .then((selectedText) => {
      if (selectedText && selectedText.length > 0) {
        // Write to both Electron and Terminal clipboards
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
  if (!view) return;
  const target = view.focusedContent;
  
  readFromSystemClipboard().then((text) => {
    if (text && text.length > 0) {
      setImmediate(() => {
        target.insertText(text);
      });
    }
  }).catch((err) => {
    console.error('[Clipboard] Read failed:', err);
  });
}

/**
 * Diagnostic tool to check if clipboard writing works at all
 */
function diagnosticCopy() {
  const testText = `CLIPBOARD TEST - ${new Date().toLocaleTimeString()}`;
  console.log('[Diagnostic] Attempting to write test text to clipboard.');
  writeToSystemClipboard(testText).catch(e => console.error(e));
}

/** @type {KeyBindingAction} */
function quit() {
  process.emit('SIGINT');
}

const config = {
  homepage,
  keybindings,
  urlBar,
  profile,
  debugPort,
  auth,
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
