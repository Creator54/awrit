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
  onToggleFind: (callback) => ipcRenderer.on('toolbar:toggle-find', (_event, visible) => callback(visible)),
  onToggleUrlBar: (callback) => ipcRenderer.on('toolbar:toggle-url-bar', () => callback()),
  onSetUrlBarVisible: (callback) => ipcRenderer.on('omnibox:set-visible', (_event, visible) => callback(visible)),
  onDesignModeChanged: (callback) => ipcRenderer.on('awrit:design-mode-changed', (_event, active) => callback(active)),
  onInputFocusChanged: (callback) => ipcRenderer.on('awrit:input-focus-changed', (_event, focused) => callback(focused)),
  onSetKeyHelpVisible: (callback) => ipcRenderer.on('awrit:set-key-help-visible', (_event, data) => callback(data)),
  onFindResult: (callback) => ipcRenderer.on('toolbar:find-result', (_event, result) => callback(result)),
  onFindNext: (callback) => ipcRenderer.on('toolbar:find-next', callback),
  onFindPrev: (callback) => ipcRenderer.on('toolbar:find-prev', callback),
  toggleUrlBar: () => ipcRenderer.send('toolbar:toggle-url-bar'),
  toggleKeyHelp: () => ipcRenderer.send('toolbar:toggle-key-help'),
  toggleFind: () => ipcRenderer.send('toolbar:toggle-find'),
  
  // Permission handling
  onPermissionRequest: (callback) => ipcRenderer.on('toolbar:permission-request', (_event, req) => callback(req)),
  resolvePermission: (id, allowed, url, permission, mediaTypes) => ipcRenderer.send('toolbar:permission-response', { id, allowed, url, permission, mediaTypes }),
  getSitePermissions: (url) => ipcRenderer.invoke('awrit:get-site-permissions', url),
  revokeSitePermission: (url, permission) => ipcRenderer.send('awrit:revoke-site-permission', url, permission),
  onSitePermissionsChanged: (callback) => ipcRenderer.on('awrit:site-permissions-changed', (_event, perms) => callback(perms)),
});
