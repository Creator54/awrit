import {
  BrowserWindow,
  type BrowserWindowConstructorOptions,
  type WebContents,
  ipcMain,
  screen,
} from 'electron';
import path from 'node:path';
import { registerPaintedContent, registerPaintedContentFallback } from './paint';
import { sessionPromise } from './session';
import { extensionsPromise, installedExtensionsPromise } from './extensions';
import { clearPlacements, paintInitialFrame } from './tty/kittyGraphics';
import * as out from './tty/output';
import { getWindowSize, ShmGraphicBuffer } from 'awrit-native-rs';

export { getWindowSize };
import { options } from './args';
import { console_ } from './console';
import { TOOLBAR_PORT } from './runner/ports';
import {
  layout,
  row,
  px,
  auto,
  calculateLayout,
  type LayoutContainer,
  type LayoutNode,
} from './layout';
import { getDisplayScale } from './dpi';
import { features } from './features';
import { updateCursor } from './tty/cursor';


export type Actions = {
  back: () => void;
  forward: () => void;
  refresh: () => void;
};

export type WindowView = {
  toolbar: BrowserWindow;
  content: BrowserWindow;
  focusedContent: WebContents;
  layoutContainer: LayoutContainer;
  toolbarNode: LayoutNode;
  contentNode: LayoutNode;
  relayout: (force?: boolean) => void;
  toggleUrlBar: () => void;
} & Actions;

export const focusedView: {
  current: WindowView | null;
  previous: WindowView | null;
} = {
  current: null,
  previous: null,
};

export const windowViews = new WeakMap<BrowserWindow, WindowView>();

const TOOLBAR_HEIGHT = 40;

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

type Size = { width: number; height: number };
// this deals with the DPI scale rounding error causing the buffer to be too small
function padSize(size: Size): Size {
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

  // Check initial URL bar visibility (from CLI or config)
  // @ts-ignore - global variable can be set in index.ts or config
  const initialUrlBarVisible = 
    options['no-url-bar'] === true || 
    (options as any)['hide-url-bar'] === true 
      ? false : (globalThis as any).__AWRIT_URL_BAR_VISIBLE__ !== false;

  // Expose URL bar visibility to toolbar renderer
  // @ts-ignore
  (globalThis as any).__AWRIT_URL_BAR_VISIBLE__ = initialUrlBarVisible;

  // Create layout nodes for toolbar and content
  const toolbarNode = row({ height: px(initialUrlBarVisible ? TOOLBAR_HEIGHT : 0), tag: 'toolbar' });
  const contentNode = row({ height: auto(), tag: 'content' });

  const hasAnimation = features.current?.loadFrame && features.current.compositeFrame;

  // Calculate layout
  calculateLayout(layoutContainer, [toolbarNode, contentNode]);

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
  });

  const destructors: Array<() => void> = [];

  function registerPaints(size: Size) {
    if (hasAnimation) {
      const containerBuffer = new ShmGraphicBuffer(size.width * size.height * 4);
      
      // Fill with opaque black immediately to cover terminal logs
      const opaqueBlack = Buffer.alloc(size.width * size.height * 4);
      for (let i = 0; i < opaqueBlack.length; i += 4) {
        opaqueBlack[i + 3] = 255; // Opaque alpha
      }
      containerBuffer.write(opaqueBlack, size.width);

      out.placeCursor({ x: 0, y: 0 });
      const containerFrame = paintInitialFrame(containerBuffer, size);
      destructors.push(
        containerFrame.free,
        registerPaintedContent(containerFrame, toolbar, toolbarNode).destroy,
        registerPaintedContent(containerFrame, content, contentNode).destroy,
      );
    } else {
      destructors.push(
        registerPaintedContentFallback(toolbar, toolbarNode).destroy,
        registerPaintedContentFallback(content, contentNode).destroy,
      );
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

  let relayoutScheduled = false;
  let lastWidth = size.width;
  let lastHeight = size.height;

  const view: WindowView = {
    toolbar,
    content,
    focusedContent: content.webContents,
    layoutContainer,
    toolbarNode,
    contentNode,
    relayout(force = false) {
      // Coalesce multiple resize events into a single relayout on next tick
      if (relayoutScheduled) return;
      relayoutScheduled = true;
      setImmediate(() => {
        relayoutScheduled = false;
        const newSize = getWindowSize();

        // Skip if the size hasn't actually changed and not forced
        if (!force && newSize.width === lastWidth && newSize.height === lastHeight) {
          return;
        }
        lastWidth = newSize.width;
        lastHeight = newSize.height;

        // Tear down old paint handlers and placements immediately
        // to prevent stale handlers from receiving events at the new size
        for (const destructor of destructors) {
          destructor();
        }
        destructors.length = 0;
        clearPlacements();

        updateViewSizes(this, newSize);
        registerPaints(padSize(newSize));

        // Force Electron to schedule a full repaint at the new size.
        // Without this, the offscreen renderer won't produce a frame
        // until something else triggers a content change (e.g. scroll).
        toolbar.webContents.invalidate();
        content.webContents.invalidate();

        // Focus and a small delay before another invalidate can help 
        // wake up the renderer if it got stuck during the transition.
        view.content.focusOnWebView();

        // Second invalidate after a small delay to ensure the renderer 
        // has processed the bounds change and is ready to produce a frame.
        setTimeout(() => {
          content.webContents.invalidate();
        }, 50);
      });
    },
    toggleUrlBar() {
      const isVisible = view.toolbarNode.height.value !== 0;
      const newHeight = isVisible ? 0 : TOOLBAR_HEIGHT;
      view.toolbarNode.height.value = newHeight;

      // Expose state to renderer
      // @ts-ignore
      (globalThis as any).__AWRIT_URL_BAR_VISIBLE__ = !isVisible;
      view.toolbar.webContents.send('toolbar:set-url-bar-visible', !isVisible);

      view.relayout(true);
    },
    back: () => {
      content.webContents.goBack();
    },
    forward: () => {
      content.webContents.goForward();
    },
    refresh: () => {
      content.webContents.reload();
    },
  };

  // Add to managed windows
  managedViews.push(view);
  focusedView.current = view;

  // Set up IPC for toolbar interactions
  setupToolbarIPC(toolbar.webContents, content.webContents, view);

  // Send initial URL bar visibility state to toolbar
  toolbar.webContents.once('did-finish-load', () => {
    toolbar.webContents.send('toolbar:set-url-bar-visible', initialUrlBarVisible);
  });

  return view;
}

function updateViewSizes(view: WindowView, { width, height }: Size) {
  const { toolbar, content, toolbarNode, contentNode } = view;
  view.layoutContainer = layout(
    width,
    height,
    getDisplayScale() ?? screen.getPrimaryDisplay().scaleFactor,
  );

  calculateLayout(view.layoutContainer, [toolbarNode, contentNode]);

  // Update window sizes based on layout
  toolbar.setContentSize(toolbarNode.computedLayout.width, toolbarNode.computedLayout.height);
  content.setContentSize(contentNode.computedLayout.width, contentNode.computedLayout.height);
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
    view.toggleUrlBar();
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

  contentContents.on('did-navigate-in-page', (_event, url, isMainFrame) => {
    if (isMainFrame) {
      toolbarContents.send('content:url-changed', url);
    }
  });

  contentContents.on('did-navigate', () => {
    const navigationState = {
      canGoBack: contentContents.navigationHistory.canGoBack(),
      canGoForward: contentContents.navigationHistory.canGoForward(),
    };
    toolbarContents.send('content:navigation-state-changed', navigationState);
  });
}
