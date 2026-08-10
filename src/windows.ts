import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type IpcMainEvent,
  type WebContents,
  ipcMain,
  screen,
  nativeTheme,
  shell,
  clipboard,
} from 'electron';
import path from 'node:path';
import { generateErrorPage, generateCrashPage, shouldIgnoreError } from './errorPage';
import { calculateLayout, layout, px, row, type LayoutContainer, type LayoutNode } from './layout';
import { registerPaintedContent, registerPaintedContentFallback } from './paint';
import { sessionPromise } from './session';
import { extensionsPromise, installedExtensionsPromise } from './extensions';
import { paintInitialFrame } from './tty/kittyGraphics';
import * as out from './tty/output';
import {
  getWindowSize as rawGetWindowSize,
  ShmGraphicBuffer,
  type WindowSize,
} from 'awrit-native-rs';
import { getAllKeyBindings } from './keybindings';
import { getZoomFactor } from './zoom-state';
import { setZoomFactor, saveZoomState } from './zoom-state';
import { setupDragAndDrop } from './dragAndDropSetup';

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

import { getDisplayScale } from './dpi';
import { features } from './features';
import { updateCursor } from './tty/cursor';

// Module-level Maps for multi-window IPC routing
const findInPageHandlers = new Map<
  number,
  (text: string, options?: Electron.FindInPageOptions) => number
>();
const stopFindInPageHandlers = new Map<number, () => void>();
let globalIpcHandlersRegistered = false;

function ensureGlobalIPCHandlers() {
  if (globalIpcHandlersRegistered) return;
  globalIpcHandlersRegistered = true;

  ipcMain.handle('findInPage', (event, text, options) => {
    const handler = findInPageHandlers.get(event.sender.id);
    if (!handler) throw new Error('No findInPage handler for this window');
    return handler(text, options);
  });

  ipcMain.handle('stopFindInPage', (event) => {
    const handler = stopFindInPageHandlers.get(event.sender.id);
    if (!handler) throw new Error('No stopFindInPage handler for this window');
    return handler();
  });
}

export type Actions = {
  back: () => void;
  forward: () => void;
  reload: () => void;
  toggleDevTools: () => void;
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
  findVisible: boolean;
  designMode: boolean;
  keyHelpVisible: boolean;
  inputFocused: boolean;
  destroyed?: boolean;
  refresh: () => void;
  relayout: (force?: boolean) => void;
  toggleOmnibox: () => void;
  toggleFind: () => void;
  toggleDesignMode: () => void;
  toggleKeyHelp: () => void;
  findNext: () => void;
  findPrev: () => void;
  toggleForceDark: () => void;
  destroy: () => void;
  startSuppression: () => void;
  stopSuppression: (delay?: number) => void;
} & Actions;

export let terminalIsFocused = true;
export function setTerminalIsFocused(focused: boolean) {
  terminalIsFocused = focused;
}
export function updateFrameRates() {
  for (const view of managedViews) {
    try {
      const isFocused = view === focusedView.current && terminalIsFocused;
      view.content.webContents.setFrameRate(isFocused ? 60 : 1);
      view.toolbar.webContents.setFrameRate(isFocused ? 30 : 1);
    } catch (_e) {}
  }
}

export const focusedView: {
  current: WindowView | null;
  previous: WindowView | null;
} = {
  current: null,
  previous: null,
};

function resetForFrameQuirk(webContents: WebContents) {
  webContents.once('did-frame-navigate', () => {
    webContents.setZoomFactor(1);
  });
}

export type WindowDimensions = { width: number; height: number };

function padSize(size: WindowDimensions): WindowDimensions {
  return {
    width: size.width + 3,
    height: size.height + 3,
  };
}

export const managedViews: WindowView[] = [];

/**
 * Creates a new window and sets focus to it.
 */
export async function createNewWindow(url = 'https://google.com'): Promise<WindowView> {
  const size = getWindowSize();
  const view = await createWindowWithToolbar(size, url);
  return view;
}

/**
 * Cycles focus to the next managed window.
 */
export function cycleFocus(): boolean {
  if (managedViews.length <= 1) return false;
  const current = focusedView.current;
  const idx = current ? managedViews.indexOf(current) : -1;
  const next = managedViews[(idx + 1) % managedViews.length];
  focusedView.previous = current;
  focusedView.current = next;
  updateFrameRates();
  next.relayout(true);
  return true;
}

/**
 * Creates a new window with a transparent architecture.
 * Websites can detect 'awrit' and use the Secure Auth Bridge for external login.
 */
export async function createWindowWithToolbar(
  size: { width: number; height: number },
  initialUrl = 'https://github.com/chase/awrit',
  windowOptions: { urlBarVisible?: boolean } = {},
): Promise<WindowView> {
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

  const omniboxVisible = windowOptions.urlBarVisible ?? false;
  let toolbarLoaded = false;

  const toolbarNode = row({ width: px(size.width), height: px(size.height), tag: 'omnibox' });
  const contentNode = row({ width: px(size.width), height: px(size.height), tag: 'content' });

  const hasAnimation = features.current?.loadFrame && features.current.compositeFrame;

  calculateLayout(layoutContainer, [contentNode]);
  calculateLayout(toolbarLayoutContainer, [toolbarNode]);

  let destroyed = false;

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
    ...(options.transparent
      ? { transparent: true, backgroundColor: '#00000000' }
      : { transparent: false, backgroundColor: '#000000' }),
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
  });

  // @ts-expect-error - dynamic property for paint suppression
  content.isSuppressingPaint = false;
  // @ts-expect-error
  content.paintCount = 0;

  setupDragAndDrop(toolbar.webContents);
  setupDragAndDrop(content.webContents);

  const destructors: Array<() => void> = [];
  const refreshers: Array<() => void> = [];

  let lastAttemptedUrl = initialUrl;
  let suppressionTimeout: NodeJS.Timeout | null = null;

  const startSuppression = () => {
    // @ts-expect-error
    content.isSuppressingPaint = true;
    // We do NOT suppress the toolbar anymore, so the progress bar stays visible
    // @ts-expect-error
    content.paintCount = 0;

    if (!options.transparent) {
      content.setBackgroundColor('#000000');
    }

    // Safety timeout: never suppress for more than 200ms (fast reveal, dark mode eliminates flash)
    if (suppressionTimeout) clearTimeout(suppressionTimeout);
    suppressionTimeout = setTimeout(() => {
      if (popupActive) return;
      // @ts-expect-error
      content.isSuppressingPaint = false;
      content.webContents.invalidate();
      suppressionTimeout = null;
    }, 200);
  };

  let popupActive = false;

  const stopSuppression = (delay = 300, force = false) => {
    if (popupActive) return; // Never unsuppress while popup is displayed
    if (suppressionTimeout) clearTimeout(suppressionTimeout);

    const execute = () => {
      // @ts-expect-error
      content.isSuppressingPaint = false;
      content.webContents.invalidate();
      suppressionTimeout = null;
    };

    if (force) {
      execute();
      return;
    }

    suppressionTimeout = setTimeout(() => {
      if (!content.webContents.isLoading() || delay === 0) {
        execute();
      } else {
        // Still loading, extend suppression
        stopSuppression(delay);
      }
    }, delay);
  };

  content.on('content-ready' as any, () => {
    if (popupActive) return;
    console_.log('[Navigation] Content-ready detected (45 frames), reveal starting...');
    stopSuppression(0, true);
  });

  content.webContents.on('did-navigate', () => {
    // Inject global scrollbar hide rules natively as User Origin to guarantee it beats website Author CSS
    // This entirely prevents the native scrollbars from flashing and guarantees websites cannot override them.
    content.webContents.insertCSS(
      `
      * { scrollbar-width: thin !important; scrollbar-color: transparent transparent !important; }
      html { scrollbar-width: none !important; }
      body { scrollbar-width: none !important; }
      ::-webkit-scrollbar { width: 4px !important; height: 4px !important; }
      html::-webkit-scrollbar, body::-webkit-scrollbar { width: 0 !important; height: 0 !important; }
      ::-webkit-scrollbar-track { background: transparent !important; }
      ::-webkit-scrollbar-thumb { background-color: transparent !important; border-radius: 2px !important; }
      ::-webkit-scrollbar-button { display: none !important; }
      ::-webkit-scrollbar-corner { background: transparent !important; }
      html.awrit-scrolling * { scrollbar-color: rgba(255,255,255,.20) transparent !important; }
      html.awrit-scrolling *::-webkit-scrollbar-thumb { background-color: rgba(255,255,255,.20) !important; }
    `,
      { cssOrigin: 'user' },
    );

    if (!options.transparent) {
      // Inject white background as a user stylesheet.
      // This ensures sites without explicit backgrounds are legible,
      // but allows site-defined backgrounds to take precedence.
      // Because the window background is PERMANENTLY black, there is no flash.
      content.webContents.insertCSS('html { background-color: #1C1B22; }', { cssOrigin: 'user' });
    }

    // Load and apply saved zoom for navigated origin
    try {
      const url = view.content.webContents.getURL();
      const origin = new URL(url).origin;
      const savedZoom = getZoomFactor(origin);
      view.content.webContents.setZoomFactor(savedZoom);
      view.toolbar.webContents.send('content:zoom-changed', savedZoom);
    } catch {}
  });

  content.webContents.on('dom-ready', () => {
    // Inject custom DOM-based scrollbar for buttery smooth hardware-accelerated transitions on the main window.
    content.webContents.executeJavaScript(`
      (function () {
        if (document.getElementById('awrit-custom-scrollbar')) return;
        
        var scrollbar = document.createElement('div');
        scrollbar.id = 'awrit-custom-scrollbar';
        Object.assign(scrollbar.style, {
          position: 'fixed',
          right: '0',
          top: '0',
          width: '4px',
          backgroundColor: 'rgba(255, 255, 255, 0.4)',
          borderRadius: '2px',
          zIndex: '2147483647',
          pointerEvents: 'none',
          transition: 'opacity 0.8s ease-out',
          opacity: '0'
        });
        (document.body || document.documentElement).appendChild(scrollbar);

        var t;
        window.addEventListener('scroll', function () {
          // Toggle class for nested scrollbars (legacy instant behavior)
          document.documentElement.classList.add('awrit-scrolling');
          
          // Smooth DOM scrollbar for root window
          var docHeight = document.documentElement.scrollHeight;
          var winHeight = window.innerHeight;
          if (docHeight > winHeight) {
            var heightRatio = winHeight / docHeight;
            var scrollbarHeight = Math.max(winHeight * heightRatio, 20);
            var scrollbarTop = (window.scrollY / (docHeight - winHeight)) * (winHeight - scrollbarHeight);
            
            scrollbar.style.height = scrollbarHeight + 'px';
            scrollbar.style.transform = 'translateY(' + scrollbarTop + 'px)';
            scrollbar.style.transition = 'opacity 0.1s ease-in';
            scrollbar.style.opacity = '1';
          }
          
          clearTimeout(t);
          t = setTimeout(function () {
            document.documentElement.classList.remove('awrit-scrolling');
            scrollbar.style.transition = 'opacity 0.8s ease-out';
            scrollbar.style.opacity = '0';
          }, 1500);
        }, { capture: true, passive: true });
      })();
    `);

    // Site has parsed its HTML, likely has content/loader to show.
    stopSuppression(1000);
  });

  function registerPaints(size: WindowDimensions) {
    destructors.forEach((d) => {
      d();
    });
    destructors.length = 0;
    refreshers.length = 0;

    if (hasAnimation) {
      // Content layer (z=0)
      const contentBuffer = new ShmGraphicBuffer(size.width * size.height * 4);
      const opaqueBlack = Buffer.alloc(size.width * size.height * 4).fill(
        Uint8Array.from([0, 0, 0, 255]),
      );
      contentBuffer.write(opaqueBlack, size.width);
      out.placeCursor({ x: 0, y: 0 });
      const contentFrame = paintInitialFrame(contentBuffer, size, { z: 0 });
      const cRef = registerPaintedContent(contentFrame, content, contentNode);

      const tRef = registerPaintedContentFallback(toolbar, toolbarNode, 1, {
        replacePlacement: true,
      });

      destructors.push(contentFrame.free, cRef.destroy, tRef.destroy);
      refreshers.push(cRef.refresh, tRef.refresh);
    } else {
      const tRef = registerPaintedContentFallback(toolbar, toolbarNode);
      const cRef = registerPaintedContentFallback(content, contentNode, undefined, {
        applyPostProcess: true,
      });
      destructors.push(tRef.destroy, cRef.destroy);
      refreshers.push(tRef.refresh, cRef.refresh);
    }
  }

  registerPaints(padSize(size));

  function loadToolbarContent() {
    if (toolbarLoaded) return;
    toolbarLoaded = true;
    if (options.dev) {
      toolbar.webContents.loadURL(`http://localhost:${TOOLBAR_PORT}`);
    } else {
      resetForFrameQuirk(toolbar.webContents);
      toolbar.webContents.loadFile('../dist/toolbar/index.html');
    }
    toolbar.webContents.invalidate();
  }

  // Toolbar is lazy-loaded on first toggle of omnibox, find, or key-help

  extensionsPromise.then((extensions) => {
    if (extensions) extensions.addTab(content.webContents, content);
  });
  await installedExtensionsPromise;

  resetForFrameQuirk(content.webContents);
  startSuppression();
  content.webContents.loadURL(initialUrl);

  // Apply saved zoom for initial URL
  try {
    const origin = new URL(initialUrl).origin;
    const savedZoom = getZoomFactor(origin);
    content.webContents.setZoomFactor(savedZoom);
  } catch {}

  content.webContents.invalidate();

  // Limit offscreen rendering frame rate to reduce CPU usage.
  // Terminals can't display faster than ~60fps anyway.
  content.webContents.setFrameRate(60);
  toolbar.webContents.setFrameRate(30); // Toolbar is mostly static

  content.webContents.setMaxListeners(30);

  toolbar.webContents.on('cursor-changed', updateCursor);
  content.webContents.on('cursor-changed', updateCursor);

  toolbar.focusOnWebView = () => {
    focusedView.current = view;
    updateFrameRates();
    view.focusedContent = toolbar.webContents;
    toolbar.focus();
    toolbar.webContents.focus();
  };
  content.focusOnWebView = () => {
    focusedView.current = view;
    updateFrameRates();
    view.focusedContent = content.webContents;
    content.focus();
    content.webContents.focus();
  };

  toolbar.blurWebView = () => {};
  content.blurWebView = () => {};

  // Handle new window requests — allow popups for OAuth (preserves window.opener)
  const handleNewWindow = ({ url, features }: { url: string; features: string }) => {
    try {
      console_.log('[Navigation] Popup requested:', url);
      // Parse requested popup dimensions from window.open features string, e.g. "width=500,height=600"
      const featureMap = new Map(
        (typeof features === 'string' ? features : '').split(',').map((f) => {
          const [k, v] = f.split('=');
          return [k.trim(), v?.trim()];
        }),
      );
      const requestedWidth = parseInt(featureMap.get('width') || '', 10);
      const requestedHeight = parseInt(featureMap.get('height') || '', 10);
      const [contentW, contentH] = content.getContentSize();
      // Use requested size if available and positive, otherwise fall back to full content size
      const w =
        Number.isFinite(requestedWidth) && requestedWidth > 0
          ? Math.min(requestedWidth, contentW)
          : contentW;
      const h =
        Number.isFinite(requestedHeight) && requestedHeight > 0
          ? Math.min(requestedHeight, contentH)
          : contentH;
      console_.log(
        `[Popup] Creating popup with dimensions ${w}x${h} (requested: ${requestedWidth || 'none'}x${requestedHeight || 'none'}, content: ${contentW}x${contentH})`,
      );

      // Use native Electron window handling!
      // By returning action: 'allow' and explicitly disabling offscreen,
      // Chromium will natively link window.opener and handle trusted MessageEvents,
      // perfectly supporting Google Identity Services.
      return {
        action: 'allow' as const,
        overrideBrowserWindowOptions: {
          show: true,
          width: w,
          height: h,
          webPreferences: {
            offscreen: false, // Must be false so the native window paints correctly
            sandbox: false, // CRITICAL: inherited sandbox: true breaks window.opener in Electron popups
            contextIsolation: false, // Required to inject into window/navigator
            preload: path.resolve(__dirname, '../dist/popup-preload.js'),
          },
        },
      };
    } catch (e) {
      console_.log('[Navigation] CRITICAL CRASH in handleNewWindow:', e);
      return { action: 'deny' as const };
    }
  };

  toolbar.webContents.setWindowOpenHandler(handleNewWindow);
  content.webContents.setWindowOpenHandler(handleNewWindow);

  content.webContents.on('will-navigate', (_event, url) => {
    if (!url.startsWith('data:text/html')) {
      lastAttemptedUrl = url;
    }
    const displayUrl = url.length > 100 ? `${url.substring(0, 100)}...` : url;
    console_.log(`[Navigation] Will navigate to: ${displayUrl}, freezing display...`);

    // If a popup is active and the main frame navigates to a different origin,
    // the popup is no longer relevant — reset suppression so the new page renders.
    if (popupActive) {
      try {
        const targetOrigin = new URL(url).origin;
        const popupWindows = BrowserWindow.getAllWindows().filter(
          (w) => w !== toolbar && w !== content && !w.isDestroyed(),
        );
        for (const popup of popupWindows) {
          const popupUrl = popup.webContents.getURL();
          if (popupUrl) {
            const popupOrigin = new URL(popupUrl).origin;
            if (targetOrigin !== popupOrigin) {
              console_.log(
                `[Navigation] Main frame navigating from popup origin ${popupOrigin} to ${targetOrigin}, resetting popup state`,
              );
              popupActive = false;
              view.focusedContent = content.webContents;
              // @ts-expect-error
              content.isSuppressingPaint = false;
              popup.close();
              break;
            }
          }
        }
      } catch (e) {
        console_.log('[Navigation] Error checking popup origin during will-navigate:', e);
      }
    }

    startSuppression();
  });

  content.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) {
      if (!url.startsWith('data:text/html')) {
        lastAttemptedUrl = url;
      }
      const displayUrl = url.length > 100 ? `${url.substring(0, 100)}...` : url;
      console_.log(
        `[Navigation] Main frame hard navigation to: ${displayUrl}, ensuring display freeze...`,
      );
      startSuppression();

      // Reset input focus state on navigation
      view.inputFocused = false;
      view.toolbar.webContents.send('awrit:input-focus-changed', false);
    }
  });

  content.webContents.on('did-finish-load', () => {
    stopSuppression(100);
  });

  content.webContents.on('did-stop-loading', () => {
    stopSuppression(200);
  });

  content.webContents.on('did-fail-load', () => {
    stopSuppression(0);
  });

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
    findVisible: false,
    designMode: !!options.design,
    keyHelpVisible: false,
    inputFocused: false,
    startSuppression,
    stopSuppression,
    refresh() {
      refreshers.forEach((r) => {
        r();
      });
    },
    relayout(force = false) {
      if (relayoutScheduled) return;
      relayoutScheduled = true;
      setImmediate(() => {
        if (destroyed) return;
        relayoutScheduled = false;
        let newSize: WindowSize;
        try {
          newSize = getWindowSize();
        } catch (e) {
          console_.error('Failed to get window size:', e);
          return;
        }

        if (newSize.width <= 0 || newSize.height <= 0) return;
        if (!force && newSize.width === lastWidth && newSize.height === lastHeight) return;
        lastWidth = newSize.width;
        lastHeight = newSize.height;

        const oldDestructors = [...destructors];
        destructors.length = 0;

        updateViewSizes(this, newSize);
        registerPaints(padSize(newSize));

        for (const destructor of oldDestructors) destructor();

        toolbar.webContents.invalidate();
        content.webContents.invalidate();

        if (this.omniboxVisible || this.findVisible) view.toolbar.focusOnWebView();
        else view.content.focusOnWebView();
      });
    },
    toggleOmnibox() {
      this.omniboxVisible = !this.omniboxVisible;

      if (this.omniboxVisible) {
        if (this.findVisible) {
          this.findVisible = false;
          if (!this.toolbar.webContents.isLoading()) {
            this.toolbar.webContents.send('toolbar:toggle-find', false);
          }
        }
        loadToolbarContent();
      }

      const sendSignal = () => {
        if (!this.toolbar.webContents.isLoading()) {
          this.toolbar.webContents.send('omnibox:set-visible', this.omniboxVisible);
        }
      };

      // Wait for load to finish if we just loaded it
      if (this.omniboxVisible && this.toolbar.webContents.isLoading()) {
        this.toolbar.webContents.once('did-finish-load', sendSignal);
      } else {
        sendSignal();
        setTimeout(sendSignal, 100);
      }

      this.toolbar.setIgnoreMouseEvents(
        !this.omniboxVisible && !this.keyHelpVisible && !this.findVisible,
      );
      if (this.omniboxVisible) {
        this.toolbar.focusOnWebView();
        this.toolbar.focus();
      } else {
        this.content.focusOnWebView();
        this.content.focus();
      }
    },
    toggleFind() {
      this.findVisible = !this.findVisible;
      if (options.dev) console_.log('[UI] toggleFind called, visible:', this.findVisible);
      if (this.findVisible) {
        this.omniboxVisible = false;
        loadToolbarContent();
      }

      const sendSignal = () => {
        if (!this.toolbar.webContents.isLoading()) {
          this.toolbar.webContents.send('toolbar:toggle-find', this.findVisible);
        }
      };

      if (this.findVisible && this.toolbar.webContents.isLoading()) {
        this.toolbar.webContents.once('did-finish-load', sendSignal);
      } else {
        sendSignal();
      }

      this.toolbar.setIgnoreMouseEvents(
        !this.findVisible && !this.omniboxVisible && !this.keyHelpVisible,
      );
      if (this.findVisible) {
        this.toolbar.focusOnWebView();
        this.toolbar.focus();
      } else {
        this.content.focusOnWebView();
        this.content.focus();
      }
    },
    toggleDesignMode() {
      this.designMode = !this.designMode;
      console_.log(`[Design Mode] ${this.designMode ? 'ENABLED' : 'DISABLED'}`);
      this.content.webContents.send('awrit:set-design-mode', this.designMode);
      this.toolbar.webContents.send('awrit:design-mode-changed', this.designMode);
    },
    toggleKeyHelp() {
      this.keyHelpVisible = !this.keyHelpVisible;

      if (this.keyHelpVisible) {
        if (this.findVisible) {
          this.findVisible = false;
          if (!this.toolbar.webContents.isLoading()) {
            this.toolbar.webContents.send('toolbar:toggle-find', false);
          }
        }
        loadToolbarContent();
        const bindings = getAllKeyBindings();

        const sendSignal = () => {
          this.toolbar.webContents.send('awrit:set-key-help-visible', {
            visible: this.keyHelpVisible,
            bindings,
          });
        };

        if (this.toolbar.webContents.isLoading()) {
          this.toolbar.webContents.once('did-finish-load', sendSignal);
        } else {
          sendSignal();
          setTimeout(sendSignal, 100);
        }

        this.toolbar.focusOnWebView();
        this.toolbar.focus();
      } else {
        this.toolbar.webContents.send('awrit:set-key-help-visible', { visible: false });
        this.content.focusOnWebView();
        this.content.focus();
      }

      this.toolbar.setIgnoreMouseEvents(
        !this.keyHelpVisible && !this.omniboxVisible && !this.findVisible,
      );
    },
    findNext() {
      this.toolbar.webContents.send('toolbar:find-next');
    },
    findPrev() {
      this.toolbar.webContents.send('toolbar:find-prev');
    },
    toggleForceDark() {
      const isDark = nativeTheme.themeSource === 'dark';
      nativeTheme.themeSource = isDark ? 'light' : 'dark';
      console_.log(`[Dark Mode] ${isDark ? 'DISABLED (light)' : 'ENABLED (dark)'}`);
      // Inject as USER origin so it beats site Author CSS (author injection
      // could be overridden). No reload needed — color-scheme applies live.
      content.webContents.insertCSS(
        `html { color-scheme: ${isDark ? 'light' : 'dark'} !important; }`,
        { cssOrigin: 'user' },
      );
    },
    back: () => {
      startSuppression();
      content.webContents.goBack();
    },
    forward: () => {
      startSuppression();
      content.webContents.goForward();
    },
    reload: () => {
      startSuppression();
      const currentUrl = content.webContents.getURL();
      if (currentUrl.startsWith('data:text/html') && lastAttemptedUrl) {
        content.webContents.loadURL(lastAttemptedUrl);
      } else {
        content.webContents.reload();
      }
    },
    toggleDevTools: () => {
      if (content.webContents.isDevToolsOpened()) {
        content.webContents.closeDevTools();
      } else {
        content.webContents.openDevTools({ mode: 'detach' });
      }
    },
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      ipcCleanup();
      ipcMain.removeListener('awrit:open-external', onOpenExternal);
      ipcMain.removeListener('awrit:copy-to-clipboard', onCopyToClipboard);
      ipcMain.removeListener('awrit:go-back', onGoBack);
      ipcMain.removeListener('awrit:input-focus', onInputFocus);

      destructors.forEach((d) => {
        d();
      });
      destructors.length = 0;
      refreshers.length = 0;
      const index = managedViews.indexOf(view);
      if (index !== -1) managedViews.splice(index, 1);
      if (focusedView.current === view) focusedView.current = null;
      if (!toolbar.isDestroyed()) toolbar.destroy();
      if (!content.isDestroyed()) content.destroy();
    },
  };

  content.on('closed', () => view.destroy());
  toolbar.on('closed', () => view.destroy());

  // Error page: show a styled page when navigation fails (network down, DNS fail, etc.)
  content.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (shouldIgnoreError(errorCode)) return;
      console_.log(
        `[Error] Page load failed: ${errorDescription} (${errorCode}) for ${validatedURL}`,
      );
      const html = generateErrorPage({ errorCode, errorDescription, failedUrl: validatedURL });
      content.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    },
  );

  // Crash recovery: show a recovery page when the renderer process dies
  content.webContents.on('render-process-gone', (_event, details) => {
    console_.error(`[Crash] Renderer process gone: ${details.reason} (exit ${details.exitCode})`);
    const html = generateCrashPage({
      reason: details.reason,
      exitCode: details.exitCode,
      failedUrl: content.webContents.getURL(),
    });
    content.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  });

  // Log when page becomes unresponsive
  content.webContents.on('unresponsive', () => {
    console_.error('[Warning] Page has become unresponsive');
  });

  content.webContents.on('responsive', () => {
    console_.log('[Info] Page is responsive again');
  });

  managedViews.push(view);
  focusedView.current = view;
  updateFrameRates();

  const ipcCleanup = setupToolbarIPC(toolbar.webContents, content.webContents, view);

  // Set initial mouse event ignore state for the toolbar overlay
  toolbar.setIgnoreMouseEvents(!view.omniboxVisible && !view.keyHelpVisible && !view.findVisible);

  const establishFocus = () => {
    if (view.omniboxVisible || view.keyHelpVisible || view.findVisible) {
      view.toolbar.focusOnWebView();
    } else {
      view.content.focusOnWebView();
    }
  };

  // Aggressive initialization focus kickstart
  // Offscreen renderers often need a few focus signals to wake up the input loop
  const kickstart = () => {
    establishFocus();
    // Dummy event to wake up the event loop
    content.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 });
  };

  kickstart();
  content.webContents.on('did-finish-load', kickstart);

  // Multiple delays ensure focus sticks after internal Chromium readiness
  setTimeout(kickstart, 500);
  setTimeout(kickstart, 1500);
  setTimeout(kickstart, 3000);

  const onOpenExternal = (event: IpcMainEvent, value: unknown) => {
    if (event.sender !== content.webContents || typeof value !== 'string') return;

    let url: URL;
    try {
      url = new URL(value);
    } catch {
      console_.error('[Auth Bridge] Rejected invalid external URL');
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      console_.error(`[Auth Bridge] Rejected external URL protocol: ${url.protocol}`);
      return;
    }

    console_.log('[Auth Bridge] Request to open external URL:', url.toString());
    void shell.openExternal(url.toString()).catch((error) => {
      console_.error('[Auth Bridge] Failed to open external URL:', error);
    });
  };

  const onCopyToClipboard = (event: IpcMainEvent, value: unknown) => {
    if (event.sender !== content.webContents || typeof value !== 'string') return;
    clipboard.writeText(value);
    out.writeToTerminalClipboard(value);
  };

  const onGoBack = (event: IpcMainEvent) => {
    if (event.sender !== content.webContents) return;
    if (content.webContents.navigationHistory.canGoBack()) {
      startSuppression();
      content.webContents.navigationHistory.goBack();
    }
  };

  const onInputFocus = (event: IpcMainEvent, focused: unknown) => {
    if (event.sender !== content.webContents || typeof focused !== 'boolean') return;
    view.inputFocused = focused;
    view.toolbar.webContents.send('awrit:input-focus-changed', focused);
  };

  ipcMain.on('awrit:open-external', onOpenExternal);
  ipcMain.on('awrit:copy-to-clipboard', onCopyToClipboard);
  ipcMain.on('awrit:go-back', onGoBack);
  ipcMain.on('awrit:input-focus', onInputFocus);

  toolbar.webContents.on('did-finish-load', () => {
    // Send the correct initial state to the toolbar to prevent desync
    toolbar.webContents.send('omnibox:set-visible', view.omniboxVisible);
    toolbar.webContents.send('awrit:input-focus-changed', view.inputFocused);
    toolbar.webContents.send('content:zoom-changed', content.webContents.getZoomFactor());
  });

  if (view.omniboxVisible) loadToolbarContent();

  // Trigger an initial relayout to ensure focus and size are perfectly synced
  setImmediate(() => {
    if (!destroyed) {
      view.relayout(true);
      // Prime the renderer with a dummy mouse event to wake up the event loop
      content.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 });
    }
  });

  return view;
}

function updateViewSizes(view: WindowView, { width, height }: WindowDimensions) {
  if (width <= 0 || height <= 0) return;

  // Update container dimensions
  view.layoutContainer.logicalWidth = width;
  view.layoutContainer.logicalHeight = height;
  view.toolbarLayoutContainer.logicalWidth = width;
  view.toolbarLayoutContainer.logicalHeight = height;

  view.toolbarNode.width = px(width);
  view.toolbarNode.height = px(height);
  view.contentNode.width = px(width);
  view.contentNode.height = px(height);
  calculateLayout(view.layoutContainer, [view.contentNode]);
  calculateLayout(view.toolbarLayoutContainer, [view.toolbarNode]);
  view.toolbar.setContentSize(width, height);
  view.content.setContentSize(width, height);
}

function setupToolbarIPC(
  toolbarContents: Electron.WebContents,
  contentContents: Electron.WebContents,
  view: WindowView,
) {
  const handlers: Record<string, any> = {
    'toolbar:navigate-back': () => {
      if (contentContents.navigationHistory.canGoBack()) {
        view.startSuppression();
        contentContents.navigationHistory.goBack();
      }
    },
    'toolbar:navigate-forward': () => {
      if (contentContents.navigationHistory.canGoForward()) {
        view.startSuppression();
        contentContents.navigationHistory.goForward();
      }
    },
    'toolbar:navigate-refresh': () => {
      view.reload();
    },
    'toolbar:navigate-to': (_e: any, url: string) => {
      view.startSuppression();
      contentContents.loadURL(url);
    },
    'toolbar:toggle-url-bar': () => view.toggleOmnibox(),
    'toolbar:visibility-applied': () => {
      toolbarContents.invalidate();
      contentContents.invalidate();
    },
    'toolbar:toggle-key-help': () => view.toggleKeyHelp(),
    'toolbar:toggle-find': () => view.toggleFind(),
    'toolbar:close': () => {
      if (view.omniboxVisible) view.toggleOmnibox();
      if (view.findVisible) view.toggleFind();
    },
    'toolbar:open-in-new-window': (_e: any, url: string) => {
      createNewWindow(url);
    },
    'omnibox:escape': () => {
      if (view.omniboxVisible) view.toggleOmnibox();
      if (view.findVisible) view.toggleFind();
    },
    'toolbar:set-zoom': (_e: any, factor: number) => {
      const clamped = Math.min(3, Math.max(0.5, factor));
      contentContents.setZoomFactor(clamped);
      toolbarContents.send('content:zoom-changed', clamped);
      try {
        const origin = new URL(contentContents.getURL()).origin;
        setZoomFactor(origin, clamped);
        // Debounced persist to avoid thrashing disk on repeated key presses.
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void saveZoomState(), 400);
      } catch {
        // URL may be unavailable (e.g. blank page); skip persistence.
      }
    },
  };

  // Wrap handlers to filter by sender so only the matching window's handler acts
  const wrappedHandlers: Record<string, any> = {};
  for (const [channel, handler] of Object.entries(handlers)) {
    wrappedHandlers[channel] = (event: any, ...args: any[]) => {
      if (event.sender === toolbarContents) {
        return handler(event, ...args);
      }
    };
    ipcMain.on(channel, wrappedHandlers[channel]);
  }

  let progressInterval: NodeJS.Timeout | null = null;
  let currentProgress = 0;
  let saveTimer: NodeJS.Timeout | null = null;

  const startProgress = () => {
    if (progressInterval) clearInterval(progressInterval);
    // Signal an indeterminate state first (negative value) so the toolbar can
    // show the sliding sliver before any real progress numbers arrive.
    toolbarContents.send('content:loading-progress', -1);
    currentProgress = 5;
    toolbarContents.send('content:loading-progress', currentProgress);
    progressInterval = setInterval(() => {
      if (currentProgress < 90) {
        currentProgress += Math.max(1, (90 - currentProgress) / 15);
        toolbarContents.send('content:loading-progress', Math.round(currentProgress));
      }
    }, 100);
  };

  const stopProgress = () => {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    toolbarContents.send('content:loading-progress', 100);
    setTimeout(() => !progressInterval && toolbarContents.send('content:loading-progress', 0), 300);
  };

  const onLoadingStarted = () => {
    toolbarContents.send('content:loading-started');
    startProgress();
  };
  const onLoadingStopped = () => {
    toolbarContents.send('content:loading-stopped');
    toolbarContents.send('content:loading-url', ''); // Clear loading URL on stop
    stopProgress();
  };
  const onDidNavigate = (_e: any, url: string) => {
    toolbarContents.send('content:url-changed', url);
    updateNavigationState();
  };
  const onDidNavigateInPage = (_e: any, url: string, isMainFrame: boolean) => {
    if (isMainFrame) {
      toolbarContents.send('content:url-changed', url);
      updateNavigationState();
    }
  };

  const onUpdateTargetUrl = (_e: any, url: string) => {
    toolbarContents.send('content:update-target-url', url);
  };

  const onDidStartNavigation = (_e: any, url: string, isInPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame && !isInPlace) {
      toolbarContents.send('content:loading-url', url);
    }
  };

  const onDidRedirectNavigation = (
    _e: any,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && !isInPlace) {
      toolbarContents.send('content:loading-url', url);
    }
  };

  const updateNavigationState = () => {
    toolbarContents.send('content:navigation-state-changed', {
      canGoBack: contentContents.navigationHistory.canGoBack(),
      canGoForward: contentContents.navigationHistory.canGoForward(),
    });
  };

  contentContents.on('found-in-page', (_event, result) => {
    toolbarContents.send('toolbar:find-result', {
      activeMatchOrdinal: result.activeMatchOrdinal,
      matches: result.matches,
    });
  });

  contentContents.on('did-start-loading', onLoadingStarted);
  contentContents.on('did-stop-loading', onLoadingStopped);
  contentContents.on('did-navigate', onDidNavigate);
  contentContents.on('did-navigate-in-page', onDidNavigateInPage);
  contentContents.on('did-start-navigation', onDidStartNavigation);
  contentContents.on('did-redirect-navigation', onDidRedirectNavigation);
  contentContents.on('did-start-navigation', updateNavigationState);
  contentContents.on('did-finish-load', updateNavigationState);
  contentContents.on('did-frame-finish-load', updateNavigationState);
  contentContents.on('update-target-url', onUpdateTargetUrl);

  // Register per-window handlers in the routing Maps
  ensureGlobalIPCHandlers();
  findInPageHandlers.set(toolbarContents.id, (text, options) =>
    contentContents.findInPage(text, options),
  );
  stopFindInPageHandlers.set(toolbarContents.id, () => {
    contentContents.stopFindInPage('clearSelection');
    view.content.focusOnWebView();
    view.focusedContent = contentContents;
  });

  return () => {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    if (saveTimer) clearTimeout(saveTimer);
    for (const [channel, handler] of Object.entries(wrappedHandlers))
      ipcMain.removeListener(channel, handler);
    // Clean up per-window handlers from the routing Maps
    findInPageHandlers.delete(toolbarContents.id);
    stopFindInPageHandlers.delete(toolbarContents.id);
    contentContents.off('did-start-loading', onLoadingStarted);
    contentContents.off('did-stop-loading', onLoadingStopped);
    contentContents.off('did-navigate', onDidNavigate);
    contentContents.off('did-navigate-in-page', onDidNavigateInPage);
    contentContents.off('did-start-navigation', onDidStartNavigation);
    contentContents.off('did-redirect-navigation', onDidRedirectNavigation);
    contentContents.off('did-start-navigation', updateNavigationState);
    contentContents.off('did-finish-load', updateNavigationState);
    contentContents.off('did-frame-finish-load', updateNavigationState);
    contentContents.off('update-target-url', onUpdateTargetUrl);
  };
}
