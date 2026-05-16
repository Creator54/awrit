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
    /**
     * Request the browser to open a URL in the user's default system browser.
     * Use this for secure authentication flows.
     */
    openExternal: (url) => {
      ipcRenderer.send('awrit:open-external', url);
    },
    /**
     * Inform the browser that an external authentication has completed.
     * Usually, deep-linking (awrit://auth) is preferred, but this can be
     * used for lighter session updates.
     */
    notifyAuthComplete: (data) => {
      ipcRenderer.send('awrit:auth-complete', data);
    }
  });
} catch (e) {
  // If contextBridge fails (e.g. isolation disabled), we do nothing.
  // We want to remain secure and not fallback to dangerous patterns.
}

// Force dark mode CSS (standard UX improvement, not "faking" identity)
if (document.documentElement) {
  const style = document.createElement('style');
  style.id = 'awrit-base-theme';
  style.innerHTML = 'html { color-scheme: dark !important; }';
  document.documentElement.appendChild(style);
}
