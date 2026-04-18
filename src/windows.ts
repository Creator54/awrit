import {
  app,
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type WebContents,
  ipcMain,
  screen,
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
import { sessionPromise } from './session';
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
  refresh: () => void;
  relayout: (force?: boolean) => void;
  toggleOmnibox: () => void;
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
    },
    backgroundColor: '#000000', // Solid black background for content to hide terminal logs
  });

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
  content.webContents.loadURL(initialUrl);
  content.webContents.invalidate();

  toolbar.webContents.on('cursor-changed', updateCursor);
  content.webContents.on('cursor-changed', updateCursor);

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
  };

  // Add to managed windows
  managedViews.push(view);
  focusedView.current = view;

  // Set up IPC for toolbar interactions
  setupToolbarIPC(toolbar.webContents, content.webContents, view);

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

  ipcMain.on('toolbar:navigate-back', () => {
    if (contentContents.navigationHistory.canGoBack()) {
      contentContents.navigationHistory.goBack();
    }
  });

  ipcMain.on('toolbar:navigate-forward', () => {
    if (contentContents.navigationHistory.canGoForward()) {
      contentContents.navigationHistory.goForward();
    }
  });

  ipcMain.on('toolbar:navigate-refresh', () => {
    contentContents.reload();
  });

  ipcMain.on('toolbar:navigate-to', (_event, url: string) => {
    contentContents.loadURL(url);
  });

  ipcMain.on('toolbar:toggle-url-bar', () => {
    view.toggleOmnibox();
  });

  ipcMain.on('toolbar:close', () => {
    if (view.omniboxVisible) {
      view.toggleOmnibox();
    }
  });

  // Global escape fallback
  ipcMain.on('omnibox:escape', () => {
    if (view.omniboxVisible) {
      view.toggleOmnibox();
    }
  });

  contentContents.on('did-start-loading', () => {
    toolbarContents.send('content:loading-started');
  });

  contentContents.on('did-stop-loading', () => {
    toolbarContents.send('content:loading-stopped');
  });

  contentContents.on('did-navigate', (_event, url) => {
    toolbarContents.send('content:url-changed', url);
  });

  const updateNavigationState = () => {
    const navigationState = {
      canGoBack: contentContents.navigationHistory.canGoBack(),
      canGoForward: contentContents.navigationHistory.canGoForward(),
    };
    toolbarContents.send('content:navigation-state-changed', navigationState);
  };

  contentContents.on('did-navigate', (event, url) => {
    toolbarContents.send('content:url-changed', url);
    updateNavigationState();
  });

  contentContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) {
      toolbarContents.send('content:url-changed', url);
      updateNavigationState();
    }
  });

  contentContents.on('did-start-navigation', updateNavigationState);
  contentContents.on('did-finish-load', updateNavigationState);
  contentContents.on('did-frame-finish-load', updateNavigationState);
}
