const { contextBridge, ipcRenderer, webFrame } = require('electron');

  // Execute in main world (worldId 0) to override native APIs if needed
  // Currently empty as native window.open is used for Auth
  try {
    webFrame.executeJavaScriptInIsolatedWorld(0, [{
      code: `
        (function() {
          // 1. Intercept navigator.clipboard.writeText
          if (navigator.clipboard && navigator.clipboard.writeText) {
            const originalWriteText = navigator.clipboard.writeText.bind(navigator.clipboard);
            navigator.clipboard.writeText = async (text) => {
              window.postMessage({ type: 'awrit:copy', text: text }, '*');
              return originalWriteText(text);
            };
          }

          // 2. Intercept standard copy events (ctrl+c, context menu, etc)
          document.addEventListener('copy', (e) => {
            const text = window.getSelection().toString();
            if (text) {
              window.postMessage({ type: 'awrit:copy', text: text }, '*');
            }
          }, true);
        })();
      `
    }]).catch(e => {
      console.error('[Awrit Preload] Failed to execute in main world:', e);
    });
  } catch (e) {
    console.error('[Awrit Preload] Failed to inject main world scripts:', e);
  }

// Listen for clipboard messages from the main world
window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'awrit:copy' && typeof event.data.text === 'string') {
    ipcRenderer.send('awrit:copy-to-clipboard', event.data.text);
  }
});

/**
 * awrit Secure Auth Bridge (Generic Solution)
 * 
 * This API is exposed to all websites loaded in awrit.
 * It allows sites to detect the browser and securely request 
 * out-of-band authentication via the user's default system browser.
 * 
 * Usage for websites:
 * if (window.awrit) {
 *   window.awrit.openExternal('https://accounts.google.com/...');
 * }
 */

try {
  contextBridge.exposeInMainWorld('awrit', {
    isAwrit: true,
    version: '2.0.3',
    openExternal: (url) => {
      ipcRenderer.send('awrit:open-external', url);
    },
  });

  ipcRenderer.on('awrit:set-design-mode', (_event, active) => {
    window.dispatchEvent(new CustomEvent('awrit:design-mode-changed', { detail: { active } }));
  });
} catch (e) {
  // If contextBridge fails (e.g. isolation disabled), we do nothing.
  // We want to remain secure and not fallback to dangerous patterns.
}

// Input focus detection — must run regardless of contextBridge success
// so vim keybinds are disabled when typing in input fields.
let lastFocused = false;
const updateFocus = () => {
  const activeEl = document.activeElement;
  const isInput = !!(activeEl && (
    ['INPUT', 'TEXTAREA', 'SELECT', 'IFRAME', 'CANVAS'].includes(activeEl.tagName) || 
    activeEl.isContentEditable ||
    activeEl.getAttribute('role') === 'textbox'
  ));
  if (isInput !== lastFocused) {
    lastFocused = isInput;
    ipcRenderer.send('awrit:input-focus', isInput);
  }
};

window.addEventListener('focusin', updateFocus);
window.addEventListener('focusout', updateFocus);
window.addEventListener('load', updateFocus);
setInterval(updateFocus, 1000);

// Force dark mode CSS (standard UX improvement, not "faking" identity)
if (document.documentElement) {
  const style = document.createElement('style');
  style.id = 'awrit-base-theme';
  style.innerHTML = 'html { color-scheme: dark !important; }';
  document.documentElement.appendChild(style);
}
