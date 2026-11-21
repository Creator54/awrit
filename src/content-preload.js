const { contextBridge, ipcRenderer, webFrame } = require('electron');

  // Execute in main world (worldId 0) to override native APIs if needed
  // Currently empty as native window.open is used for Auth
  try {
    webFrame.executeJavaScriptInIsolatedWorld(0, [{
      code: `
        (function() {
          // Offscreen pages cannot reach the system clipboard. Report button
          // copies; the isolated world only accepts them during a real gesture.
          const clip = navigator.clipboard;
          if (clip && clip.writeText) {
            const writeText = clip.writeText.bind(clip);
            clip.writeText = (text) => {
              window.postMessage({ type: 'awrit:write-text', text: String(text) }, '*');
              return writeText(text);
            };
          }

          // Polyfill visual drag image for OSR
          let dragClone = null;
          let dragOffsetX = 0;
          let dragOffsetY = 0;
          
          document.addEventListener('dragstart', (e) => {
            if (dragClone) { dragClone.remove(); dragClone = null; }
            const target = e.target.nodeType === 3 ? e.target.parentElement : e.target;
            if (target && target.cloneNode && target.getBoundingClientRect) {
              const rect = target.getBoundingClientRect();
              dragOffsetX = e.clientX - rect.left;
              dragOffsetY = e.clientY - rect.top;
              
              dragClone = target.cloneNode(true);
              dragClone.style.position = 'fixed';
              dragClone.style.top = (e.clientY - dragOffsetY) + 'px';
              dragClone.style.left = (e.clientX - dragOffsetX) + 'px';
              dragClone.style.width = rect.width + 'px';
              dragClone.style.height = rect.height + 'px';
              dragClone.style.margin = '0';
              dragClone.style.boxSizing = 'border-box';
              dragClone.style.opacity = '0.9';
              dragClone.style.pointerEvents = 'none';
              dragClone.style.zIndex = '2147483647';
              dragClone.style.boxShadow = '0 10px 20px rgba(0,0,0,0.5)';
              
              const compBg = window.getComputedStyle(target).backgroundColor;
              if (compBg === 'rgba(0, 0, 0, 0)' || compBg === 'transparent') {
                dragClone.style.backgroundColor = '#222';
                dragClone.style.borderRadius = '8px';
                dragClone.style.padding = '4px';
              }
              
              // Prevent inherited transforms or transition animations from breaking the fixed position
              dragClone.style.transform = 'none';
              dragClone.style.transition = 'none';
              dragClone.style.animation = 'none';
              
              document.body.appendChild(dragClone);
            }
          }, true);
          
          document.addEventListener('dragover', (e) => {
            if (dragClone) {
              dragClone.style.top = (e.clientY - dragOffsetY) + 'px';
              dragClone.style.left = (e.clientX - dragOffsetX) + 'px';
            }
          }, true);
          
          document.addEventListener('dragend', (e) => {
            if (dragClone) {
              dragClone.remove();
              dragClone = null;
            }
          }, true);
          
          document.addEventListener('drop', (e) => {
            if (dragClone) {
              dragClone.remove();
              dragClone = null;
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

// Keep terminal clipboard synchronization in the isolated world. Page messages
// and synthetic copy events must not become privileged clipboard writes.
document.addEventListener('copy', (event) => {
  if (!event.isTrusted) return;
  const text = window.getSelection()?.toString();
  if (text) ipcRenderer.send('awrit:copy-to-clipboard', text);
}, true);

// The page can post this message itself, so it is honored only while the user's
// own click or key is active: the same rule browsers apply to writeText.
window.addEventListener('message', (event) => {
  if (event.source !== window || event.data?.type !== 'awrit:write-text') return;
  if (typeof event.data.text !== 'string' || !event.data.text || !navigator.userActivation?.isActive) return;
  ipcRenderer.send('awrit:copy-to-clipboard', event.data.text);
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
    version: '2.3.0', // x-release-please-version
    openExternal: (url) => {
      ipcRenderer.send('awrit:open-external', url);
    },
    goBack: () => {
      ipcRenderer.send('awrit:go-back');
    },
    retry: () => {
      ipcRenderer.send('awrit:retry');
    },
    pickFolder: () => ipcRenderer.invoke('awrit:pick-folder'),
    setAdbControlsVisible: (visible) => {
      ipcRenderer.send('awrit:adb-controls-visible', !!visible);
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
