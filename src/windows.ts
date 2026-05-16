import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type WebContents,
  ipcMain,
  screen,
  nativeTheme,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {
  calculateLayout,
  layout,
  px,
  row,
  auto,
  type LayoutContainer,
  type LayoutNode,
  type Size,
} from './layout';
import { registerPaintedContent, registerPaintedContentFallback } from './paint';
import { Mode, setModes } from './tty/output';
import {
  sessionPromise,
  isGoogleDomain,
  getUAForURL,
  setUseFirefoxSpoof,
} from './session';
import { isGoogleOAuthUrl, OAuthManager } from './auth';
import { oauthConfig } from './authConfig';
import { extensionsPromise, installedExtensionsPromise } from './extensions';
import { clearPlacements, paintInitialFrame } from './tty/kittyGraphics';
import * as out from './tty/output';
import { getWindowSize as rawGetWindowSize, ShmGraphicBuffer } from 'awrit-native-rs';

export function getWindowSize() {
  try {
    return rawGetWindowSize();
  } catch (e) {
    console_.error('Failed to get window size:', e);
    return { width: 0, height: 0, cols: 0, rows: 0 };
  }
}
import { options } from './args';
import { console_ } from './console';
import { TOOLBAR_PORT } from './runner/ports';

// Log redirection handled in index.ts

import { getDisplayScale } from './dpi';
import { features } from './features';
import { updateCursor } from './tty/cursor';


export type Actions = {
  back: () => void;
  forward: () => void;
  reload: () => void;
};

export type WindowView = {
  toolbar: BrowserWindow;
  content: BrowserWindow;
  focusedContent: WebContents;
  layoutContainer: LayoutContainer;
  toolbarLayoutContainer: LayoutContainer;
  toolbarNode: LayoutNode;
  contentNode: LayoutNode;
  omniboxVisible: boolean;
  destroyed?: boolean;
  refresh: () => void;
  relayout: (force?: boolean) => void;
  toggleOmnibox: () => void;
  destroy: () => void;
} & Actions;

export const focusedView: {
  current: WindowView | null;
  previous: WindowView | null;
} = {
  current: null,
  previous: null,
};

export const windowViews = new WeakMap<BrowserWindow, WindowView>();

const OMNIBOX_WIDTH_PERCENT = 0.7;
const OMNIBOX_HEIGHT_PERCENT = 0.4;
const OMNIBOX_MIN_WIDTH = 400;
const OMNIBOX_MIN_HEIGHT = 100;

/**
 * NOTE: the happens before load but after frame navigate
 * this is necessary because zoom can only be set when a URL is associated with the webContents
 *
 * This also prevents users from persisting zoom level which is bad, so we probably want
 * to store that somewhere if the user changes zoom and restore that number instead
 */
function resetForFrameQuirk(webContents: WebContents) {
  webContents.once('did-frame-navigate', () => {
    webContents.setZoomFactor(1);
  });
}

export type WindowDimensions = { width: number; height: number };

// this deals with the DPI scale rounding error causing the buffer to be too small
function padSize(size: WindowDimensions): WindowDimensions {
  return {
    width: size.width + 3,
    height: size.height + 3,
  };
}

export const managedViews: WindowView[] = [];
/**
 * Creates a new window with a toolbar and main content area
 * @param size Window size
 * @param initialUrl URL to load in the main content area
 * @returns The created window
 */
export async function createWindowWithToolbar(
  size: { width: number; height: number },
  initialUrl = 'https://github.com/chase/awrit',
): Promise<WindowView> {
  console_.error('size', size);
  // Create layout container with device pixel dimensions
  const layoutContainer = layout(
    size.width,
    size.height,
    getDisplayScale() ?? screen.getPrimaryDisplay().scaleFactor,
  );

  const toolbarLayoutContainer = layout(
    size.width,
    size.height,
    getDisplayScale() ?? screen.getPrimaryDisplay().scaleFactor,
  );

  // Omnibox starts hidden by default now
  let omniboxVisible = false;

  // Create layout nodes with explicit initial sizes to prevent 0x0 bugs
  const toolbarNode = row({ 
    width: px(size.width), 
    height: px(size.height), 
    tag: 'omnibox' 
  });
  const contentNode = row({ 
    width: px(size.width), 
    height: px(size.height), 
    tag: 'content' 
  });

  const hasAnimation = features.current?.loadFrame && features.current.compositeFrame;

  // Calculate layouts in separate containers so they overlap instead of splitting the screen
  calculateLayout(layoutContainer, [contentNode]);
  calculateLayout(toolbarLayoutContainer, [toolbarNode]);

  // Explicitly clear the terminal to hide build logs before first paint
  out.clearScreen();

  let destroyed = false;

  const transparentWindowSettings = {
    transparent: true,
    backgroundColor: '#00000000',
  };

  const sharedConstructorOptions: BrowserWindowConstructorOptions = {
    useContentSize: true,
    show: false,
    frame: false,
    paintWhenInitiallyHidden: true,
    hiddenInMissionControl: true,
    acceptFirstMouse: true,
    skipTaskbar: true,
    fullscreenable: false,
    resizable: false,
  };

  const toolbar = new BrowserWindow({
    ...sharedConstructorOptions,
    ...toolbarNode.computedLayout,
    transparent: true,
    backgroundColor: '#00000000',

    webPreferences: {
      zoomFactor: 1,
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      disableBlinkFeatures: 'AutomationControlled',

      preload: path.resolve(__dirname, '../dist/preload.js'),
    },
  });

  const content = new BrowserWindow({
    ...sharedConstructorOptions,
    ...contentNode.computedLayout,

    transparent: !!options.transparent,
    ...(options.transparent ? transparentWindowSettings : {}),

    webPreferences: {
      zoomFactor: 1,
      session: await sessionPromise,

      sandbox: true,
      offscreen: true,
      nodeIntegration: false,
      contextIsolation: true,
      disableDialogs: true,
      disableBlinkFeatures: 'AutomationControlled',
      preload: path.resolve(__dirname, '../dist/content-preload.js'),
    },
    backgroundColor: '#000000', // Solid black background for content to hide terminal logs
  });

  // Attempt to restore Google session if tokens exist
  if (oauthConfig.clientId) {
    // Disable Firefox spoofing since we are using official system browser flows
    setUseFirefoxSpoof(false);
    
    const manager = new OAuthManager(oauthConfig);
    manager.getValidToken().then(async token => {
      if (token) {
        console_.log('Restoring Google session from saved tokens...');
        await manager.establishSession(content.webContents.session, token);
      }
    }).catch(err => {
      console_.error('Failed to restore Google session on startup:', err);
    });
  }

  const destructors: Array<() => void> = [];
  const refreshers: Array<() => void> = [];

  function registerPaints(size: WindowDimensions) {
    destructors.forEach((d) => d());
    destructors.length = 0;
    refreshers.length = 0;

    if (hasAnimation) {
      // Content layer (z=0)
      const contentBuffer = new ShmGraphicBuffer(size.width * size.height * 4);
      const opaqueBlack = Buffer.alloc(size.width * size.height * 4).fill(Uint8Array.from([0, 0, 0, 255]));
      contentBuffer.write(opaqueBlack, size.width * 4);
      out.placeCursor({ x: 0, y: 0 });
      const contentFrame = paintInitialFrame(contentBuffer, size, { z: 0 });
      const cRef = registerPaintedContent(contentFrame, content, contentNode);

      // Toolbar layer (z=1)
      const toolbarBuffer = new ShmGraphicBuffer(size.width * size.height * 4);
      const transparentBlack = Buffer.alloc(size.width * size.height * 4).fill(Uint8Array.from([0, 0, 0, 0]));
      toolbarBuffer.write(transparentBlack, size.width * 4);
      out.placeCursor({ x: 0, y: 0 });
      const toolbarFrame = paintInitialFrame(toolbarBuffer, size, { z: 1 });
      const tRef = registerPaintedContent(toolbarFrame, toolbar, toolbarNode);

      destructors.push(
        contentFrame.free,
        toolbarFrame.free,
        cRef.destroy,
        tRef.destroy,
      );

      refreshers.push(cRef.refresh, tRef.refresh);
    } else {
      const tRef = registerPaintedContentFallback(toolbar, toolbarNode);
      const cRef = registerPaintedContentFallback(content, contentNode);
      destructors.push(
        tRef.destroy,
        cRef.destroy,
      );
      refreshers.push(tRef.refresh, cRef.refresh);
    }
  }

  registerPaints(padSize(size));

  // Start loading toolbar immediately so it can paint its skeleton
  if (options.dev) {
    toolbar.webContents.loadURL(`http://localhost:${TOOLBAR_PORT}`);
  } else {
    resetForFrameQuirk(toolbar.webContents);
    toolbar.webContents.loadFile('../dist/toolbar/index.html');
  }

  // Force an early paint for the toolbar to show the UI
  toolbar.webContents.invalidate();

  // Add to extensions
  extensionsPromise.then((extensions) => {
    extensions.addTab(content.webContents, content);
  });
  await installedExtensionsPromise;

  if (options.dev) {
    toolbar.webContents.once('did-finish-load', () => {
      console_.error('toolbar loaded');
    });
    toolbar.webContents.once('did-fail-load', (_event, errorCode, errorDescription) => {
      console_.error('toolbar failed to load', {
        errorCode,
        errorDescription,
      });
    });
    toolbar.webContents.openDevTools({
      mode: 'detach',
      title: 'Toolbar Dev Tools',
      activate: false,
    });
  }
  resetForFrameQuirk(content.webContents);
  content.webContents.loadURL(initialUrl, { userAgent: getUAForURL(initialUrl) });
  content.webContents.invalidate();

  toolbar.webContents.on('cursor-changed', updateCursor);
  content.webContents.on('cursor-changed', updateCursor);

  // ===========================================
  // Main-world anti-detection injection
  // contextIsolation=true means preload window.* mocks don't reach the page.
  // Google OAuth probes window.chrome, Notification, performance.memory, etc.
  // On Google pages (Firefox spoof): delete Chrome-only APIs that Firefox lacks.
  // On other pages (Chrome): mock the full Chrome API surface.
  // ===========================================
  const mainWorldAntiDetection = `
    (function() {
      if (window.__awrit_antidetect_done) return;
      window.__awrit_antidetect_done = true;

      // Detect if we're on a Google domain (Firefox-spoofed)
      // MUST match session.ts isGoogleDomain()
      var h = location.hostname;
      var isGoogle = (h === 'google.com' || h.endsWith('.google.com') ||
                     h === 'youtube.com' || h.endsWith('.youtube.com') ||
                     h === 'googleapis.com' || h.endsWith('.googleapis.com') ||
                     h === 'gstatic.com' || h.endsWith('.gstatic.com') ||
                     h === 'ggpht.com' ||
                     h === 'googleusercontent.com' || h.endsWith('.googleusercontent.com')) 
                     && window.__awrit_use_firefox_spoof;
      window.__awrit_is_google = isGoogle;

      if (isGoogle) {
        // ===== FIREFOX MODE (Google domain) =====
        // Firefox does NOT have: navigator.userAgentData, window.chrome,
        // navigator.plugins (Chrome-style), performance.memory, etc.
        // Delete them to match Firefox behavior.

        try { delete Navigator.prototype.userAgentData; } catch(e) {}
        try { delete window.chrome; } catch(e) {}
        try { Object.defineProperty(window, 'chrome', { get: () => undefined, configurable: true }); } catch(e) {}

        // Firefox specific properties
        try { window.InstallTrigger = {}; } catch(e) {}
        try { window.sidebar = { addSearchEngine: () => {}, addPanel: () => {} }; } catch(e) {}

        // navigator.webdriver should be undefined in Firefox too
        try { Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined, configurable: true, enumerable: true }); } catch(e) {}

        // Fix navigator properties that preload set to Chrome values.
        // Firefox has different plugins, vendor, and no userAgentData.
        // Delete the preload's Chrome-style overrides so Chromium defaults show through
        // (or we set Firefox-compatible values).
        try { delete Navigator.prototype.plugins; } catch(e) {}
        try { delete Navigator.prototype.mimeTypes; } catch(e) {}
        // Firefox vendor is empty string, not 'Google Inc.'
        try { Object.defineProperty(Navigator.prototype, 'vendor', { get: function() { return ''; }, configurable: true, enumerable: true }); } catch(e) {}
        // Firefox languages format
        try { Object.defineProperty(Navigator.prototype, 'languages', { get: function() { return ['en-US', 'en']; }, configurable: true, enumerable: true }); } catch(e) {}

        // Notification.permission — Firefox returns 'default' by default
        if (window.Notification && window.Notification.permission === 'granted') {
          try {
            Object.defineProperty(window.Notification, 'permission', {
              get: () => 'default', configurable: true,
            });
          } catch(e) {}
        }

      } else {
        // ===== CHROME MODE (non-Google) =====
        // Full Chrome API mocks for sites that fingerprint.

        // 1. window.chrome
        if (typeof window.chrome === 'undefined') {
          window.chrome = {};
        }
        var chrome = window.chrome;

        if (!chrome.runtime) {
          chrome.runtime = {
            OnInstalledReason: { CHROME_UPDATE: 'chrome_update', INSTALL: 'install', SHARED_MODULE_UPDATE: 'shared_module_update', UPDATE: 'update' },
            OnRestartRequiredReason: { APP_UPDATE: 'app_update', OS_UPDATE: 'os_update', PERIODIC: 'periodic' },
            PlatformArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformNaclArch: { ARM: 'arm', MIPS: 'mips', MIPS64: 'mips64', X86_32: 'x86-32', X86_64: 'x86-64' },
            PlatformOs: { ANDROID: 'android', CROS: 'cros', LINUX: 'linux', MAC: 'mac', OPENBSD: 'openbsd', WIN: 'win' },
            RequestUpdateCheckStatus: { NO_UPDATE: 'no_update', THROTTLED: 'throttled', UPDATE_AVAILABLE: 'update_available' },
            sendMessage: function() { return Promise.resolve(); },
            onMessage: { addListener: function() {}, removeListener: function() {} },
            onConnect: { addListener: function() {}, removeListener: function() {} },
            connect: function() {
              return {
                onMessage: { addListener: function() {}, removeListener: function() {} },
                onDisconnect: { addListener: function() {}, removeListener: function() {} },
                postMessage: function() {},
                disconnect: function() {},
              };
            },
            getManifest: function() { return { manifest_version: 2, name: '', version: '1.0' }; },
            getURL: function(path) { return 'chrome-extension://' + path; },
            id: undefined,
            OnConnect: { addListener: function() {} },
            OnMessage: { addListener: function() {} },
          };
        }

        if (!chrome.app) {
          chrome.app = {
            isInstalled: false,
            InstallState: { DISABLED: 'disabled', INSTALLED: 'installed', NOT_INSTALLED: 'not_installed' },
            RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
            runtime: {
              onLaunched: { addListener: function() {} },
              onRestarted: { addListener: function() {} },
              onEmbedRequested: { addListener: function() {} },
            },
            window: {
              create: function() { return Promise.resolve(); },
              current: function() { return null; },
            },
          };
        }

        if (!chrome.loadTimes) {
          chrome.loadTimes = function() {
            var now = Date.now() / 1000;
            return {
              commitLoadTime: now, connectionInfo: 'h2',
              finishDocumentLoadTime: now, finishLoadTime: now,
              firstPaintAfterLoadTime: 0, firstPaintTime: now,
              navigationType: 'Other', npnNegotiatedProtocol: 'h2',
              requestTime: now, startLoadTime: now,
              wasAlternateProtocolAvailable: false,
              wasFetchedViaSpdy: true, wasNpnNegotiated: true,
            };
          };
        }

        if (!chrome.csi) {
          chrome.csi = function() {
            return { onloadT: Date.now(), pageT: Date.now() / 1000, startE: Date.now(), tran: 15 };
          };
        }

        // 2. Notification.permission
        if (typeof window.Notification !== 'undefined' && window.Notification.permission === 'granted') {
          try {
            Object.defineProperty(window.Notification, 'permission', {
              get: () => 'default', configurable: true,
            });
          } catch(e) {}
        }
        if (typeof window.Notification !== 'undefined' && !window.Notification.requestPermission) {
          window.Notification.requestPermission = function(cb) {
            if (cb) cb('default');
            return Promise.resolve('default');
          };
        }

        // 3. performance.memory — Chrome-only
        if (!window.performance.memory) {
          Object.defineProperty(window.performance, 'memory', {
            get: () => ({
              usedJSHeapSize: 12000000,
              totalJSHeapSize: 22000000,
              jsHeapSizeLimit: 2190000000,
            }),
            configurable: true,
          });
        }

        // 4. navigator.storage.estimate
        if (navigator.storage && navigator.storage.estimate) {
          var origEstimate = navigator.storage.estimate.bind(navigator.storage);
          navigator.storage.estimate = function() {
            return origEstimate().then(function(est) {
              if (!est || est.quota === 0) {
                return { quota: 274877906944, usage: 12000000, usageDetails: {} };
              }
              return est;
            }).catch(function() {
              return { quota: 274877906944, usage: 12000000, usageDetails: {} };
            });
          };
        }

        // 5. navigator.credentials
        if (!navigator.credentials) {
          Object.defineProperty(navigator, 'credentials', {
            get: () => ({
              get: function() { return Promise.reject(new DOMException('Not allowed', 'NotAllowedError')); },
              create: function() { return Promise.reject(new DOMException('Not allowed', 'NotAllowedError')); },
              preventSilentAccess: function() { return Promise.resolve(); },
              store: function() { return Promise.reject(new DOMException('Not allowed', 'NotAllowedError')); },
            }),
            configurable: true,
          });
        }

        // 6. navigator.mediaCapabilities
        if (!navigator.mediaCapabilities) {
          Object.defineProperty(navigator, 'mediaCapabilities', {
            get: () => ({
              decodingInfo: function() { return Promise.resolve({ supported: true, smooth: true, powerEfficient: true }); },
              encodingInfo: function() { return Promise.resolve({ supported: true, smooth: true, powerEfficient: false }); },
            }),
            configurable: true,
          });
        }
      }

      // Shared: Notification.permission fix for both modes
      if (typeof window.Notification !== 'undefined' && window.Notification.permission === 'granted') {
        try {
          Object.defineProperty(window.Notification, 'permission', {
            get: () => 'default', configurable: true,
          });
        } catch(e) {}
      }
    })();
  `;

  // Inject on every main-frame navigation (before page scripts run)
  content.webContents.on('did-start-navigation', (event, url, isInPlace, isMainFrame) => {
    if (isMainFrame) {
      if (isGoogleOAuthUrl(url)) {
        console_.log('Detected Google OAuth URL:', url);
        
        if (oauthConfig.clientId) {
          // Prevent the navigation in Electron
          event.preventDefault();
          
          // Show a helpful message in awrit
          content.webContents.executeJavaScript(`
            document.body.innerHTML = \`
              <div style="background: #1C1B22; color: white; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: sans-serif;">
                <h1 style="margin-bottom: 10px;">Login with Google</h1>
                <p style="color: #ccc; margin-bottom: 20px;">Please complete the login in your system browser...</p>
                <div style="width: 40px; height: 40px; border: 3px solid rgba(255,255,255,0.1); border-top-color: white; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 30px;"></div>
                <button onclick="window.history.back()" style="background: rgba(255,255,255,0.1); color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 14px;">Cancel</button>
                <style>
                  @keyframes spin { to { transform: rotate(360deg); } }
                </style>
              </div>
            \`;
          `).catch(() => {});

          const manager = new OAuthManager(oauthConfig);
          manager.authenticate().then(async tokens => {
            console_.log('Successfully got OAuth tokens');
            
            try {
              // Use the access token to set session cookies in Electron
              await manager.establishSession(content.webContents.session, tokens.access_token);
              console_.log('Google session established. Reloading page...');
              
              // Reload to apply cookies
              content.webContents.reload();
            } catch (sessionErr) {
              console_.error('Failed to establish session from token:', sessionErr);
              // Fallback: at least we have the token
            }
          }).catch(err => {
            console_.error('OAuth authentication failed:', err);
          });
          return;
        }
      }
      const injection = `window.__awrit_use_firefox_spoof = ${oauthConfig.clientId ? 'false' : 'true'};\n` + mainWorldAntiDetection;
      content.webContents.executeJavaScript(injection, true).catch(() => {});
    }
  });
  // Fallback: inject again when DOM is ready (catches early inline scripts)
  content.webContents.on('dom-ready', () => {
    const injection = `window.__awrit_use_firefox_spoof = ${oauthConfig.clientId ? 'false' : 'true'};\n` + mainWorldAntiDetection;
    content.webContents.executeJavaScript(injection, true).catch(() => {});
  });
  // Also inject right now for the initial load
  const injection = `window.__awrit_use_firefox_spoof = ${oauthConfig.clientId ? 'false' : 'true'};\n` + mainWorldAntiDetection;
  content.webContents.executeJavaScript(injection, true).catch(() => {});

  // Force dark color scheme via CSS injection for websites that support light/dark modes
  content.webContents.on('did-finish-load', () => {
    content.webContents.insertCSS('html { color-scheme: dark !important; }').catch(() => {});
  });
  content.webContents.on('did-navigate-in-page', () => {
    content.webContents.insertCSS('html { color-scheme: dark !important; }').catch(() => {});
  });

  // @ts-ignore - monkey patch for focus management
  toolbar.focusOnWebView = () => {
    focusedView.current = view;
    view.focusedContent = toolbar.webContents;
  };
  // @ts-ignore
  content.focusOnWebView = () => {
    focusedView.current = view;
    view.focusedContent = content.webContents;
  };
  // @ts-ignore
  toolbar.blurWebView = () => {};
  // @ts-ignore
  content.blurWebView = () => {};

  let relayoutScheduled = false;
  let lastWidth = size.width;
  let lastHeight = size.height;

  const view: WindowView = {
    toolbar,
    content,
    focusedContent: content.webContents,
    layoutContainer,
    toolbarLayoutContainer,
    toolbarNode,
    contentNode,
    omniboxVisible,
    refresh() {
      refreshers.forEach((r) => r());
    },
    relayout(force = false) {
      // Coalesce multiple resize events into a single relayout on next tick
      if (relayoutScheduled) return;
      relayoutScheduled = true;
      setImmediate(() => {
        if (destroyed) return;
        relayoutScheduled = false;
        let newSize;
        try {
          newSize = getWindowSize();
        } catch (e) {
          console_.error('Failed to get window size:', e);
          return;
        }

        // Skip if the size hasn't actually changed, or if it's invalid (0x0)
        if (newSize.width <= 0 || newSize.height <= 0) {
          return;
        }
        if (!force && newSize.width === lastWidth && newSize.height === lastHeight) {
          return;
        }
        lastWidth = newSize.width;
        lastHeight = newSize.height;

        // Capture old paint handlers to tear them down after new ones are placed.
        const oldDestructors = [...destructors];
        destructors.length = 0;

        updateViewSizes(this, newSize);
        registerPaints(padSize(newSize));

        // Tear down old handlers ONLY after the new background is placed.
        for (const destructor of oldDestructors) {
          destructor();
        }

        // Force Electron to schedule a full repaint at the new size.
        toolbar.webContents.invalidate();
        content.webContents.invalidate();

        if (this.omniboxVisible) {
          view.toolbar.focusOnWebView();
        } else {
          view.content.focusOnWebView();
        }

      });
    },
    toggleOmnibox() {
      this.omniboxVisible = !this.omniboxVisible;
      console.log(`[Omnibox] Toggling visibility: ${this.omniboxVisible}`);
      
      // Send signal to frontend - retry if not loaded yet
      const sendSignal = () => {
        if (!this.toolbar.webContents.isLoading()) {
          this.toolbar.webContents.send('omnibox:set-visible', this.omniboxVisible);
        }
      };
      
      sendSignal();
      // Also send after a short delay just in case
      setTimeout(sendSignal, 100);
      
      // Toggle mouse ignorance
      this.toolbar.setIgnoreMouseEvents(!this.omniboxVisible);

      if (this.omniboxVisible) {
        this.toolbar.focus();
      } else {
        this.content.focus();
      }
    },
    back: () => {
      content.webContents.goBack();
    },
    forward: () => {
      content.webContents.goForward();
    },
    reload: () => {
      content.webContents.reload();
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      
      // Cleanup IPC listeners
      ipcCleanup();
      
      // Cleanup paint handlers and buffers
      destructors.forEach(d => d());
      destructors.length = 0;
      refreshers.length = 0;
      
      // Remove from managed views
      const index = managedViews.indexOf(view);
      if (index !== -1) {
        managedViews.splice(index, 1);
      }
      
      if (focusedView.current === view) {
        focusedView.current = null;
      }
      
      // Destroy windows
      if (!toolbar.isDestroyed()) toolbar.destroy();
      if (!content.isDestroyed()) content.destroy();
    }
  };

  // Cleanup when window is closed
  content.on('closed', () => view.destroy());
  toolbar.on('closed', () => view.destroy());

  // Add to managed windows
  managedViews.push(view);
  focusedView.current = view;

  // Set up IPC for toolbar interactions
  const ipcCleanup = setupToolbarIPC(toolbar.webContents, content.webContents, view);

  // Initial state is hidden
  toolbar.webContents.once('did-finish-load', () => {
    toolbar.webContents.send('omnibox:set-visible', false);
  });

  return view;
}

function updateViewSizes(view: WindowView, { width, height }: WindowDimensions) {
  if (width <= 0 || height <= 0) return;

  const { toolbar, content, toolbarNode, contentNode, omniboxVisible } = view;
  const dpr = getDisplayScale() ?? screen.getPrimaryDisplay().scaleFactor;
  // Update containers with new size
  view.layoutContainer = layout(width, height, dpr);
  view.toolbarLayoutContainer = layout(width, height, dpr);

  // Update layout node dimensions to match the new window size
  toolbarNode.width = px(width);
  toolbarNode.height = px(height);
  contentNode.width = px(width);
  contentNode.height = px(height);

  // Re-calculate layouts for both independent full-screen layers
  calculateLayout(view.layoutContainer, [contentNode]);
  calculateLayout(view.toolbarLayoutContainer, [toolbarNode]);

  // Update Electron window sizes
  toolbar.setContentSize(width, height);
  content.setContentSize(width, height);
}

function setupToolbarIPC(
  toolbarContents: Electron.WebContents,
  contentContents: Electron.WebContents,
  view: WindowView,
) {
  const handlers: Record<string, any> = {
    'toolbar:navigate-back': () => {
      if (contentContents.navigationHistory.canGoBack()) {
        contentContents.navigationHistory.goBack();
      }
    },
    'toolbar:navigate-forward': () => {
      if (contentContents.navigationHistory.canGoForward()) {
        contentContents.navigationHistory.goForward();
      }
    },
    'toolbar:navigate-refresh': () => {
      contentContents.reload();
    },
    'toolbar:navigate-to': (_event: any, url: string) => {
      contentContents.loadURL(url, { userAgent: getUAForURL(url) });
    },
    'toolbar:toggle-url-bar': () => {
      view.toggleOmnibox();
    },
    'toolbar:close': () => {
      if (view.omniboxVisible) {
        view.toggleOmnibox();
      }
    },
    'omnibox:escape': () => {
      if (view.omniboxVisible) {
        view.toggleOmnibox();
      }
    },
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.on(channel, handler);
  }

  const onLoadingStarted = () => toolbarContents.send('content:loading-started');
  const onLoadingStopped = () => toolbarContents.send('content:loading-stopped');
  const onDidNavigate = (_event: any, url: string) => {
    toolbarContents.send('content:url-changed', url);
    contentContents.setUserAgent(getUAForURL(url));
    updateNavigationState();
  };
  const onDidNavigateInPage = (_event: any, url: string, isMainFrame: boolean) => {
    if (isMainFrame) {
      toolbarContents.send('content:url-changed', url);
      updateNavigationState();
      contentContents.setUserAgent(getUAForURL(url));
    }
  };

  const updateNavigationState = () => {
    const navigationState = {
      canGoBack: contentContents.navigationHistory.canGoBack(),
      canGoForward: contentContents.navigationHistory.canGoForward(),
    };
    toolbarContents.send('content:navigation-state-changed', navigationState);
  };

  contentContents.on('did-start-loading', onLoadingStarted);
  contentContents.on('did-stop-loading', onLoadingStopped);
  contentContents.on('did-navigate', onDidNavigate);
  contentContents.on('did-navigate-in-page', onDidNavigateInPage);
  contentContents.on('did-start-navigation', updateNavigationState);
  contentContents.on('did-finish-load', updateNavigationState);
  contentContents.on('did-frame-finish-load', updateNavigationState);

  return () => {
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.removeListener(channel, handler);
    }
    contentContents.off('did-start-loading', onLoadingStarted);
    contentContents.off('did-stop-loading', onLoadingStopped);
    contentContents.off('did-navigate', onDidNavigate);
    contentContents.off('did-navigate-in-page', onDidNavigateInPage);
    contentContents.off('did-start-navigation', updateNavigationState);
    contentContents.off('did-finish-load', updateNavigationState);
    contentContents.off('did-frame-finish-load', updateNavigationState);
  };
}
