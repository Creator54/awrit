import { contextBridge, ipcRenderer } from 'electron';

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('ipc', {
  // Navigation functions
  navigateBack: () => ipcRenderer.send('toolbar:navigate-back'),
  navigateForward: () => ipcRenderer.send('toolbar:navigate-forward'),
  refresh: () => ipcRenderer.send('toolbar:navigate-refresh'),
  navigateTo: (url) => ipcRenderer.send('toolbar:navigate-to', url),

  // Find in page functions
  findInPage: (text, options) => ipcRenderer.invoke('findInPage', text, options),
  stopFindInPage: () => ipcRenderer.invoke('stopFindInPage'),

  // Event listeners
  onLoadingStarted: (callback) => ipcRenderer.on('content:loading-started', callback),
  onLoadingStopped: (callback) => ipcRenderer.on('content:loading-stopped', callback),
  onLoadingProgress: (callback) => ipcRenderer.on('content:loading-progress', (_event, progress) => callback(progress)),
  onLoadingUrl: (callback) => ipcRenderer.on('content:loading-url', (_event, url) => callback(url)),
  onUrlChanged: (callback) => ipcRenderer.on('content:url-changed', (_event, url) => callback(url)),
  onUpdateTargetUrl: (callback) => ipcRenderer.on('content:update-target-url', (_event, url) => callback(url)),
  onNavigationStateChanged: (callback) =>
    ipcRenderer.on('content:navigation-state-changed', (_event, state) => callback(state)),
  onZoomChanged: (callback) => ipcRenderer.on('content:zoom-changed', (_event, factor) => callback(factor)),
  onToggleFind: (callback) => ipcRenderer.on('toolbar:toggle-find', (_event, visible) => callback(visible)),
  onSetUrlBarVisible: (callback) =>
    ipcRenderer.on('omnibox:set-visible', (_event, visible) => {
      callback(visible);
      requestAnimationFrame(() => ipcRenderer.send('toolbar:visibility-applied'));
    }),
  onDesignModeChanged: (callback) => ipcRenderer.on('awrit:design-mode-changed', (_event, active) => callback(active)),
  onDesignFrozenFrame: (callback) => {
    const handler = (_event, frame) => callback(frame);
    ipcRenderer.on('awrit:design-frozen-frame', handler);
    return () => ipcRenderer.removeListener('awrit:design-frozen-frame', handler);
  },
  inspectElementAtPoint: (x, y, up) => ipcRenderer.invoke('awrit:inspect-element-at-point', x, y, up),
  enterDesignMode: () => ipcRenderer.send('awrit:enter-design-mode'),
  exitDesignMode: () => ipcRenderer.send('awrit:exit-design-mode'),
  designFrameReady: (captureId) => ipcRenderer.send('awrit:design-frame-ready', captureId),
  listReviewRecipients: () => ipcRenderer.invoke('awrit:list-review-recipients'),
  selectReviewRecipient: (id) => ipcRenderer.invoke('awrit:select-review-recipient', id),
  saveDesignDraft: (draft) => ipcRenderer.invoke('awrit:save-design-draft', draft),
  sendDesignFeedback: (draft) => ipcRenderer.invoke('awrit:send-design-feedback', draft),
  onInputFocusChanged: (callback) => ipcRenderer.on('awrit:input-focus-changed', (_event, focused) => callback(focused)),
  onSetKeyHelpVisible: (callback) => ipcRenderer.on('awrit:set-key-help-visible', (_event, data) => callback(data)),
  onFindResult: (callback) => ipcRenderer.on('toolbar:find-result', (_event, result) => callback(result)),
  onFindNext: (callback) => ipcRenderer.on('toolbar:find-next', callback),
  onFindPrev: (callback) => ipcRenderer.on('toolbar:find-prev', callback),
  setSiteInfoOpen: (open) => ipcRenderer.send('toolbar:site-info-open', open),
  onCloseSiteInfo: (callback) => ipcRenderer.on('toolbar:close-site-info', () => callback()),
  toggleUrlBar: () => ipcRenderer.send('toolbar:toggle-url-bar'),
  toggleKeyHelp: () => ipcRenderer.send('toolbar:toggle-key-help'),
  selectTab: (index) => ipcRenderer.send('toolbar:select-tab', index),
  closeTabAt: (index) => ipcRenderer.send('toolbar:close-tab-at', index),
  onSetTabs: (callback) => ipcRenderer.on('omnibox:set-tabs', (_event, tabs) => callback(tabs)),
  toggleFind: () => ipcRenderer.send('toolbar:toggle-find'),
  openInNewWindow: (url) => ipcRenderer.send('toolbar:open-in-new-window', url),
  setZoom: (factor) => ipcRenderer.send('toolbar:set-zoom', factor),
  
  // Permission handling
  onPermissionRequest: (callback) => ipcRenderer.on('toolbar:permission-request', (_event, req) => callback(req)),
  resolvePermission: (id, allowed, url, permission, mediaTypes) => ipcRenderer.send('toolbar:permission-response', { id, allowed, url, permission, mediaTypes }),
  getSitePermissions: (url) => ipcRenderer.invoke('awrit:get-site-permissions', url),
  getSiteInfo: (url) => ipcRenderer.invoke('awrit:get-site-info', url),
  clearSiteCookies: (url) => ipcRenderer.invoke('awrit:clear-site-cookies', url),
  setSitePermission: (url, permission, choice) => ipcRenderer.send('awrit:set-site-permission', url, permission, choice),
  onSitePermissionsChanged: (callback) => ipcRenderer.on('awrit:site-permissions-changed', (_event, perms) => callback(perms)),
  onScrollSuggestions: (callback) => ipcRenderer.on('toolbar:scroll-suggestions', (_event, deltaY) => callback(deltaY)),
});
