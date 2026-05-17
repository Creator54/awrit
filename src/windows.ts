import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type WebContents,
  ipcMain,
  screen,
  nativeTheme,
  shell,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { generateErrorPage, generateCrashPage, shouldIgnoreError } from './errorPage';
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
import { sessionPromise } from './session';
import { 
  getProviderForUrl, 
  OAuthManager, 
} from './auth';
import { extensionsPromise, installedExtensionsPromise } from './extensions';
import { clearPlacements, paintInitialFrame } from './tty/kittyGraphics';
import * as out from './tty/output';
import { getWindowSize as rawGetWindowSize, ShmGraphicBuffer, type WindowSize } from 'awrit-native-rs';
import { getAllKeyBindings } from './keybindings';

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
  designMode: boolean;
  keyHelpVisible: boolean;
  destroyed?: boolean;
  refresh: () => void;
  relayout: (force?: boolean) => void;
  toggleOmnibox: () => void;
  toggleDesignMode: () => void;
  toggleKeyHelp: () => void;
  destroy: () => void;
} & Actions;

export const focusedView: {
  current: WindowView | null;
  previous: WindowView | null;
} = {
  current: null,
  previous: null,
};


const OMNIBOX_WIDTH_PERCENT = 0.7;
const OMNIBOX_HEIGHT_PERCENT = 0.4;
const OMNIBOX_MIN_WIDTH = 400;
const OMNIBOX_MIN_HEIGHT = 100;

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
    backgroundColor: '#000000',
  });

  const destructors: Array<() => void> = [];
  const refreshers: Array<() => void> = [];

  function registerPaints(size: WindowDimensions) {
    destructors.forEach((d) => { d(); });
    destructors.length = 0;
    refreshers.length = 0;

    if (hasAnimation) {
      // Content layer (z=0)
      const contentBuffer = new ShmGraphicBuffer(size.width * size.height * 4);
      const opaqueBlack = Buffer.alloc(size.width * size.height * 4).fill(Uint8Array.from([0, 0, 0, 255]));
      contentBuffer.write(opaqueBlack, size.width);
      out.placeCursor({ x: 0, y: 0 });
      const contentFrame = paintInitialFrame(contentBuffer, size, { z: 0 });
      const cRef = registerPaintedContent(contentFrame, content, contentNode);

      // Toolbar layer (z=1)
      const toolbarBuffer = new ShmGraphicBuffer(size.width * size.height * 4);
      const transparentBlack = Buffer.alloc(size.width * size.height * 4).fill(Uint8Array.from([0, 0, 0, 0]));
      toolbarBuffer.write(transparentBlack, size.width);
      out.placeCursor({ x: 0, y: 0 });
      const toolbarFrame = paintInitialFrame(toolbarBuffer, size, { z: 1 });
      const tRef = registerPaintedContent(toolbarFrame, toolbar, toolbarNode);

      destructors.push(contentFrame.free, toolbarFrame.free, cRef.destroy, tRef.destroy);
      refreshers.push(cRef.refresh, tRef.refresh);
    } else {
      const tRef = registerPaintedContentFallback(toolbar, toolbarNode);
      const cRef = registerPaintedContentFallback(content, contentNode);
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

  // Eagerly load the toolbar to prevent offscreen focus black holes
  loadToolbarContent();

  extensionsPromise.then((extensions) => {
    if (extensions) extensions.addTab(content.webContents, content);
  });
  await installedExtensionsPromise;

  resetForFrameQuirk(content.webContents);
  content.webContents.loadURL(initialUrl);
  content.webContents.invalidate();

  // Limit offscreen rendering frame rate to reduce CPU usage.
  // Terminals can't display faster than ~30fps anyway.
  content.webContents.setFrameRate(30);
  toolbar.webContents.setFrameRate(15); // Toolbar is mostly static

  toolbar.webContents.on('cursor-changed', updateCursor);
  content.webContents.on('cursor-changed', updateCursor);

  // @ts-expect-error - monkey patch for focus management
  toolbar.focusOnWebView = () => {
    focusedView.current = view;
    view.focusedContent = toolbar.webContents;
    toolbar.focus();
    toolbar.webContents.focus();
  };
  // @ts-expect-error
  content.focusOnWebView = () => {
    focusedView.current = view;
    view.focusedContent = content.webContents;
    content.focus();
    content.webContents.focus();
  };

  // @ts-expect-error
  toolbar.blurWebView = () => {};
  // @ts-expect-error
  content.blurWebView = () => {};

  // Handle new window requests transparently
  const handleNewWindow = ({ url }: { url: string }) => {
    console_.log('[Navigation] Intercepted popup request, navigating main frame:', url);
    content.webContents.loadURL(url);
    return { action: 'deny' as const };
  };

  toolbar.webContents.setWindowOpenHandler(handleNewWindow);
  content.webContents.setWindowOpenHandler(handleNewWindow);

  content.webContents.on('did-start-navigation', (event, url, isInPlace, isMainFrame) => {
    if (isMainFrame) {
      console_.log(`[Navigation] Main frame navigating to: ${url}`);

      const provider = getProviderForUrl(url);
      if (provider) {
        console_.log(`[Auth Bridge] Intercepted navigation for provider [${provider.name}], triggering system browser...`);
        
        // Prevent the navigation in Electron
        event.preventDefault();
        
        // Show a helpful message in awrit
        content.webContents.executeJavaScript(`
          document.body.innerHTML = \`
            <div style="background: #1C1B22; color: white; height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; font-family: sans-serif;">
              <h1 style="margin-bottom: 10px;">Login with ${provider.name.charAt(0).toUpperCase() + provider.name.slice(1)}</h1>
              <p style="color: #ccc; margin-bottom: 20px;">Please complete the login in your system browser...</p>
              <div style="width: 40px; height: 40px; border: 3px solid rgba(255,255,255,0.1); border-top-color: white; border-radius: 50%; animation: spin 1s linear infinite; margin-bottom: 30px;"></div>
              <button onclick="window.history.back()" style="background: rgba(255,255,255,0.1); color: white; border: none; padding: 10px 20px; border-radius: 4px; cursor: pointer; font-size: 14px;">Cancel</button>
              <style>
                @keyframes spin { to { transform: rotate(360deg); } }
              </style>
            </div>
          \`;
        `).catch(() => {});

        const manager = new OAuthManager(provider);
        manager.authenticate().then(async tokens => {
          console_.log(`[Auth Bridge] Successfully got tokens for ${provider.name}`);
          if (provider.establishSession) {
            await provider.establishSession(content.webContents.session, tokens.access_token);
          }
          content.webContents.reload();
        }).catch(err => {
          console_.error(`[Auth Bridge] Failed:`, err);
        });
      }
    }
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
    designMode: !!options.design,
    keyHelpVisible: false,
    refresh() {
      refreshers.forEach((r) => { r(); });
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

        if (this.omniboxVisible) view.toolbar.focusOnWebView();
        else view.content.focusOnWebView();
      });
    },
    toggleOmnibox() {
      this.omniboxVisible = !this.omniboxVisible;
      
      if (this.omniboxVisible) {
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

      this.toolbar.setIgnoreMouseEvents(!this.omniboxVisible && !this.keyHelpVisible);
      if (this.omniboxVisible) {
        // @ts-expect-error
        this.toolbar.focusOnWebView();
        this.toolbar.focus();
      } else {
        // @ts-expect-error
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
        loadToolbarContent();
        const bindings = getAllKeyBindings();
        
        const sendSignal = () => {
          this.toolbar.webContents.send('awrit:set-key-help-visible', {
            visible: this.keyHelpVisible,
            bindings
          });
        };

        if (this.toolbar.webContents.isLoading()) {
          this.toolbar.webContents.once('did-finish-load', sendSignal);
        } else {
          sendSignal();
          setTimeout(sendSignal, 100);
        }
        
        // @ts-expect-error
        this.toolbar.focusOnWebView();
        this.toolbar.focus();
      } else {
        this.toolbar.webContents.send('awrit:set-key-help-visible', { visible: false });
        // @ts-expect-error
        this.content.focusOnWebView();
        this.content.focus();
      }
      
      this.toolbar.setIgnoreMouseEvents(!this.keyHelpVisible && !this.omniboxVisible);
    },
    back: () => content.webContents.goBack(),
    forward: () => content.webContents.goForward(),
    reload: () => content.webContents.reload(),
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      ipcCleanup();
      ipcMain.removeListener('awrit:open-external', onOpenExternal);
      ipcMain.removeListener('awrit:request-secure-login', onRequestSecureLogin);
      destructors.forEach(d => { d(); });
      destructors.length = 0;
      refreshers.length = 0;
      const index = managedViews.indexOf(view);
      if (index !== -1) managedViews.splice(index, 1);
      if (focusedView.current === view) focusedView.current = null;
      if (!toolbar.isDestroyed()) toolbar.destroy();
      if (!content.isDestroyed()) content.destroy();
    }
  };

  content.on('closed', () => view.destroy());
  toolbar.on('closed', () => view.destroy());

  // Error page: show a styled page when navigation fails (network down, DNS fail, etc.)
  content.webContents.on(
    'did-fail-load',
    (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame) return;
      if (shouldIgnoreError(errorCode)) return;
      console_.log(`[Error] Page load failed: ${errorDescription} (${errorCode}) for ${validatedURL}`);
      const html = generateErrorPage({ errorCode, errorDescription, failedUrl: validatedURL });
      content.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    },
  );

  // Crash recovery: show a recovery page when the renderer process dies
  content.webContents.on('render-process-gone', (_event, details) => {
    console_.error(`[Crash] Renderer process gone: ${details.reason} (exit ${details.exitCode})`);
    const html = generateCrashPage({ reason: details.reason, exitCode: details.exitCode });
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

  const ipcCleanup = setupToolbarIPC(toolbar.webContents, content.webContents, view);

  // Set initial mouse event ignore state for the toolbar overlay
  toolbar.setIgnoreMouseEvents(!view.omniboxVisible && !view.keyHelpVisible);

  const establishFocus = () => {
    if (view.omniboxVisible || view.keyHelpVisible) {
      // @ts-expect-error
      view.toolbar.focusOnWebView();
    } else {
      // @ts-expect-error
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

  const onOpenExternal = (_event: any, url: string) => {

    console_.log('[Auth Bridge] Request to open external URL:', url);
    shell.openExternal(url);
  };
  
  const onRequestSecureLogin = (_event: any, config: any) => {
    console_.log(`[Auth Bridge] Received login request for: ${config.name}`);
    const manager = new OAuthManager(config);
    manager.authenticate().then(async tokens => {
      console_.log(`[Auth Bridge] Login successful for ${config.name}`);
      if (config.name === 'google') {
        const { establishGoogleSession } = require('./auth');
        await establishGoogleSession(content.webContents.session, tokens.access_token);
      }
      content.webContents.reload();
    }).catch(err => console_.error(`[Auth Bridge] Login failed:`, err));
  };

  ipcMain.on('awrit:open-external', onOpenExternal);
  ipcMain.on('awrit:request-secure-login', onRequestSecureLogin);

  toolbar.webContents.on('did-finish-load', () => {
    // Send the correct initial state to the toolbar to prevent desync
    toolbar.webContents.send('omnibox:set-visible', view.omniboxVisible);
  });

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
    'toolbar:navigate-back': () => contentContents.navigationHistory.canGoBack() && contentContents.navigationHistory.goBack(),
    'toolbar:navigate-forward': () => contentContents.navigationHistory.canGoForward() && contentContents.navigationHistory.goForward(),
    'toolbar:navigate-refresh': () => contentContents.reload(),
    'toolbar:navigate-to': (_e: any, url: string) => contentContents.loadURL(url),
    'toolbar:toggle-url-bar': () => view.toggleOmnibox(),
    'toolbar:toggle-key-help': () => view.toggleKeyHelp(),
    'toolbar:close': () => view.omniboxVisible && view.toggleOmnibox(),
    'omnibox:escape': () => view.omniboxVisible && view.toggleOmnibox(),
  };

  for (const [channel, handler] of Object.entries(handlers)) ipcMain.on(channel, handler);

  let progressInterval: NodeJS.Timeout | null = null;
  let currentProgress = 0;

  const startProgress = () => {
    if (progressInterval) clearInterval(progressInterval);
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
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
    toolbarContents.send('content:loading-progress', 100);
    setTimeout(() => !progressInterval && toolbarContents.send('content:loading-progress', 0), 300);
  };

  const onLoadingStarted = () => { toolbarContents.send('content:loading-started'); startProgress(); };
  const onLoadingStopped = () => { toolbarContents.send('content:loading-stopped'); stopProgress(); };
  const onDidNavigate = (_e: any, url: string) => {
    toolbarContents.send('content:url-changed', url);
    updateNavigationState();
  };
  const onDidNavigateInPage = (_e: any, url: string, isMainFrame: boolean) => {
    if (isMainFrame) { toolbarContents.send('content:url-changed', url); updateNavigationState(); }
  };

  const updateNavigationState = () => {
    toolbarContents.send('content:navigation-state-changed', {
      canGoBack: contentContents.navigationHistory.canGoBack(),
      canGoForward: contentContents.navigationHistory.canGoForward(),
    });
  };

  contentContents.on('did-start-loading', onLoadingStarted);
  contentContents.on('did-stop-loading', onLoadingStopped);
  contentContents.on('did-navigate', onDidNavigate);
  contentContents.on('did-navigate-in-page', onDidNavigateInPage);
  contentContents.on('did-start-navigation', updateNavigationState);
  contentContents.on('did-finish-load', updateNavigationState);
  contentContents.on('did-frame-finish-load', updateNavigationState);

  return () => {
    if (progressInterval) { clearInterval(progressInterval); progressInterval = null; }
    for (const [channel, handler] of Object.entries(handlers)) ipcMain.removeListener(channel, handler);
    contentContents.off('did-start-loading', onLoadingStarted);
    contentContents.off('did-stop-loading', onLoadingStopped);
    contentContents.off('did-navigate', onDidNavigate);
    contentContents.off('did-navigate-in-page', onDidNavigateInPage);
    contentContents.off('did-start-navigation', updateNavigationState);
    contentContents.off('did-finish-load', updateNavigationState);
    contentContents.off('did-frame-finish-load', updateNavigationState);
  };
}
