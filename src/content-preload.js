const { contextBridge, ipcRenderer } = require('electron');

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
    notifyAuthComplete: (data) => {
      ipcRenderer.send('awrit:auth-complete', data);
    }
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
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName) || 
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
