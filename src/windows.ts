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
  dialog,
} from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { generateErrorPage, generateCrashPage, shouldIgnoreError } from './errorPage';
import { calculateLayout, layout, px, row, type LayoutContainer, type LayoutNode } from './layout';
import { coverPixel, getWindowSize, registerPaintedContent, registerPaintedContentFallback } from './paint';
import { sessionPromise } from './session';
import { extensionsPromise, installedExtensionsPromise } from './extensions';
import { clearPlacements, paintInitialFrame } from './tty/kittyGraphics';
import * as defaultOutput from './tty/output';
import type { TerminalContext } from './terminal/context';
import { RendererRouter } from './ipc/rendererRouter';
import { ShmGraphicBuffer, type WindowSize } from 'awrit-native-rs';
import { getAllKeyBindings } from './keybindings';
import { getZoomFactor } from './zoom-state';
import { setZoomFactor, saveZoomState } from './zoom-state';
import { setupDragAndDrop } from './dragAndDropSetup';
import { setupFileChooser } from './fileChooser';
import { setupFolderPicker } from './folderPicker';
import { withConstructionCleanup } from './lifecycle';
import { startPageRecording } from './browserOwner/tools/pageLog';
import { withoutAgentPreview } from './browserOwner/tools/preview';

import { options } from './args';
import { console_ } from './console';
import { TOOLBAR_PORT } from './runner/ports';

import { parseTerminalReviewTarget } from './design/terminalReview';
import { saveReviewCapture } from './design/reviewSession';
import { registerDesignIpc } from './design/windowDesignIpc';
import { getAppDataPath } from './paths';
import { initSessionWorkspace } from './session/workspace';
import { readCodeSource, readCodeSnapshot } from './design/codeSource';
import { getDisplayScale } from './dpi';
import { features } from './features';
import { createCursorUpdater } from './tty/cursor';

// Module-level Maps for multi-window IPC routing
const findInPageHandlers = new Map<
  number,
  (text: string, options?: Electron.FindInPageOptions) => number
>();
const stopFindInPageHandlers = new Map<number, () => void>();
let globalIpcHandlersRegistered = false;
const toolbarInvokeHandlers = new Map<string, RendererRouter<(...args: any[]) => unknown>>();
function registerToolbarHandler(
  channel: string,
  sender: number,
  handler: (...args: any[]) => unknown,
) {
  let handlers = toolbarInvokeHandlers.get(channel);
  if (!handlers) {
    handlers = new RendererRouter();
    toolbarInvokeHandlers.set(channel, handlers);
    ipcMain.handle(channel, (event, ...args) => {
      const target = toolbarInvokeHandlers.get(channel)?.get(event.sender.id);
      if (!target) throw new Error('Unknown toolbar renderer');
      return target(event, ...args);
    });
  }
  handlers.add(sender, handler);
}

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

export interface ViewerBinding {
  state: 'unattached' | 'bound' | 'orphaned';
  clientSocket?: import('node:net').Socket;
  harness?: string;
  sourceWindowId?: string | null;
  agentPid?: number;
  cwd?: string;
  orphanedAt?: number;
}

export type WindowView = {
  onCopyToClipboard?: (text: string) => void;
  terminal?: TerminalContext;
  adbMode: boolean;
  adbSerial?: string;
  toolbar: BrowserWindow;
  content: BrowserWindow;
  binding?: ViewerBinding;
  focusedContent: WebContents;
  layoutContainer: LayoutContainer;
  toolbarLayoutContainer: LayoutContainer;
  toolbarNode: LayoutNode;
  contentNode: LayoutNode;
  omniboxVisible: boolean;
  findVisible: boolean;
  designMode: boolean;
  /** A site permission prompt is showing in the toolbar and owns the keyboard. */
  permissionPending: boolean;
  /** The lock's site-info panel is open in the omnibox; Escape closes it before the omnibox. */
  siteInfoOpen: boolean;
  keyHelpVisible: boolean;
  inputFocused: boolean;
  adbControlsVisible?: boolean;
  adbServerUrl?: string;
  readonly destroyed?: boolean;
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
  windowOptions: {
    urlBarVisible?: boolean;
    adbMode?: boolean;
    adbSerial?: string;
    onResize?: (size: WindowDimensions) => void;
    adbServerUrl?: string;
    terminal?: TerminalContext;
    session?: Electron.Session;
    assetDirectory?: string;
    isActive?: () => boolean;
    /** Remote pane: hand page copies to the owner instead of mutating this host's clipboard. */
    onCopyToClipboard?: (text: string) => void;
    /** Remote pane: hand page link requests to the owner instead of opening a local browser. */
    onOpenExternal?: (url: string) => void;
    /** Remote pane: report that a page file chooser cannot reach this host's files. */
    onFileChooserUnsupported?: () => void;
    onFileChooser?: (
      options: Electron.OpenDialogOptions,
      signal: AbortSignal,
      install: (file: string) => Promise<void>,
    ) => Promise<Electron.OpenDialogReturnValue>;
  } = {},
): Promise<WindowView> {
  return withConstructionCleanup(async (onFailure) => {
    const terminal = windowOptions.terminal;
    const isActive = windowOptions.isActive ?? (() => true);
    let designResizePending = false;
    const assetDirectory = windowOptions.assetDirectory ?? path.resolve(__dirname, '../dist');
    const transparent = terminal?.settings.transparent ?? Boolean(options.transparent);
    // A native terminal review lets Kitty's own background show through.
    const terminalReview = parseTerminalReviewTarget(initialUrl);
    const design = terminal?.settings.design ?? Boolean(options.design);
    const noPaint = terminal?.settings.noPaint ?? Boolean(options['no-paint']);
    const out = terminal?.output ?? defaultOutput;
    const graphics = terminal?.graphics;
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

    const terminalFeatures = terminal?.features ?? features.current;
    const hasAnimation =
      !windowOptions.adbMode && terminalFeatures?.loadFrame && terminalFeatures.compositeFrame;

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
        preload: path.join(assetDirectory, 'preload.js'),
      },
    });
    // webContents throws once the window is destroyed, so keep the id for cleanup.
    const toolbarContentsId = toolbar.webContents.id;

    onFailure(() => {
      if (!toolbar.isDestroyed()) toolbar.destroy();
    });
    const content = new BrowserWindow({
      ...sharedConstructorOptions,
      ...contentNode.computedLayout,
      ...(transparent || terminalReview
        ? { transparent: true, backgroundColor: '#00000000' }
        : { transparent: false, backgroundColor: terminal?.identity.terminalBackground ?? '#000000' }),
      webPreferences: {
        zoomFactor: 1,
        session: windowOptions.session ?? (await sessionPromise),
        sandbox: true,
        offscreen: true,
        nodeIntegration: false,
        contextIsolation: true,

        disableDialogs: true,
        disableBlinkFeatures: 'AutomationControlled',
        preload: path.join(assetDirectory, 'content-preload.js'),
      },
    });

    onFailure(() => {
      if (!content.isDestroyed()) content.destroy();
    });
    // @ts-expect-error - dynamic property for paint suppression
    content.isSuppressingPaint = false;
    // @ts-expect-error
    content.paintCount = 0;
    // Debugging tools read console and network from the first byte of the load.
    startPageRecording(content.webContents);

    const stopToolbarDragAndDrop = setupDragAndDrop(toolbar.webContents);
    const stopContentDragAndDrop = setupDragAndDrop(content.webContents);
    onFailure(stopToolbarDragAndDrop);
    onFailure(stopContentDragAndDrop);
    // Linux only: Chromium's chooser crashes on Wayland and shows nothing on X11 for offscreen pages.
    // A remote pane intercepts everywhere so the page learns no host dialog can open.
    const stopContentFileChooser = windowOptions.onFileChooser
      ? setupFileChooser(content.webContents, windowOptions.onFileChooser, () => {
          windowOptions.onFileChooserUnsupported?.();
          content.close();
        }, true)
      : windowOptions.onFileChooserUnsupported
      ? setupFileChooser(content.webContents, () => {
          windowOptions.onFileChooserUnsupported?.();
          return Promise.resolve({ canceled: true, filePaths: [] });
        }, () => {
          windowOptions.onFileChooserUnsupported?.();
          // Fail closed: never leave a remote page able to open a native host dialog.
          content.close();
        })
      : process.platform === 'linux'
        ? setupFileChooser(content.webContents, options => dialog.showOpenDialog(options))
        : () => {};
    onFailure(stopContentFileChooser);
    // Same Linux-only need as file inputs; remote panes stay unable to open a host dialog.
    const stopFolderPicker = process.platform === 'linux' && !windowOptions.onFileChooserUnsupported
      ? setupFolderPicker(content.webContents, options => dialog.showOpenDialog(options))
      : () => {};
    onFailure(stopFolderPicker);

    const destructors: Array<() => void> = [];
    onFailure(() => {
      for (const dispose of destructors.splice(0)) dispose();
    });
    // Track every per-window IPC channel at registration so teardown cannot drift.
    const ipcListeners: Array<[string, Parameters<typeof ipcMain.on>[1]]> = [];
    const listen = (channel: string, handler: Parameters<typeof ipcMain.on>[1]) => {
      ipcListeners.push([channel, handler]);
      ipcMain.on(channel, handler);
    };
    const stopListeners = () => {
      for (const [channel, handler] of ipcListeners.splice(0)) {
        ipcMain.removeListener(channel, handler);
      }
    };
    const stopToolbarHandlers = () => {
      for (const router of toolbarInvokeHandlers.values()) router.remove(toolbarContentsId);
    };
    const refreshers: Array<() => void> = [];

    const recoveryAddresses = new Map<string, string>();
    let pendingRecoveryUrl: string | null = null;
    let currentCaptureMeta: import('./design/windowDesignIpc').DesignCaptureMeta | null = null;
    // Assigned once, when the design IPC registers; the view's relayout calls it later, so it
    // needs a name before registration.
    let requestTerminalRefresh: () => Promise<void>;
    const getAddress = (url = content.webContents.getURL()) => recoveryAddresses.get(url) ?? url;
    const showRecoveryPage = (html: string, failedUrl: string) => {
      const historyUrls = new Set(
        content.webContents.navigationHistory.getAllEntries().map((entry) => entry.url),
      );
      for (const url of recoveryAddresses.keys()) {
        if (!historyUrls.has(url)) recoveryAddresses.delete(url);
      }
      const url = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      // Register before loading so navigation events always display the failed address.
      recoveryAddresses.set(url, failedUrl);
      pendingRecoveryUrl = url;
      void content.webContents.loadURL(url);
    };
    const trimRecoveryHistory = (url: string) => {
      const isNewRecovery = url === pendingRecoveryUrl;
      pendingRecoveryUrl = null;
      if (!isNewRecovery) return;
      const failedUrl = recoveryAddresses.get(url);
      if (!failedUrl) return;
      const history = content.webContents.navigationHistory;
      let index = history.getActiveIndex();
      // Replace only the immediately preceding failed navigation, preserving older visits.
      if (index > 0 && history.getEntryAtIndex(index - 1).url === failedUrl) {
        if (!history.removeEntryAtIndex(index - 1)) return;
        index = history.getActiveIndex();
      }
      while (index > 0) {
        const previous = history.getEntryAtIndex(index - 1);
        if (recoveryAddresses.get(previous.url) !== failedUrl) break;
        if (!history.removeEntryAtIndex(index - 1)) break;
        index = history.getActiveIndex();
      }
    };
    let suppressionTimeout: NodeJS.Timeout | null = null;
    let suppressionDeadline = 0;
    content.once('closed', () => {
      if (suppressionTimeout) clearTimeout(suppressionTimeout);
      suppressionTimeout = null;
    });

    const startSuppression = () => {
      // @ts-expect-error
      content.isSuppressingPaint = true;
      // We do NOT suppress the toolbar anymore, so the progress bar stays visible
      // @ts-expect-error
      content.paintCount = 0;

      if (!transparent && !terminalReview) {
        content.setBackgroundColor(terminal?.identity.terminalBackground ?? '#000000');
      }

      // Loading callbacks must not extend the navigation freeze beyond 200 ms.
      suppressionDeadline = Date.now() + 200;
      if (suppressionTimeout) clearTimeout(suppressionTimeout);
      suppressionTimeout = setTimeout(() => {
        if (popupActive || content.isDestroyed() || content.webContents.isDestroyed()) return;
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
        if (content.isDestroyed() || content.webContents.isDestroyed()) return;
        // @ts-expect-error
        content.isSuppressingPaint = false;
        content.webContents.invalidate();
        suppressionTimeout = null;
      };

      if (force) {
        execute();
        return;
      }

      suppressionTimeout = setTimeout(
        execute,
        Math.min(delay, Math.max(0, suppressionDeadline - Date.now())),
      );
    };

    content.on('content-ready' as any, () => {
      if (popupActive) return;
      console_.log('[Navigation] Content-ready detected (45 frames), reveal starting...');
      stopSuppression(0, true);
    });

    content.webContents.on('did-navigate', (_event, url) => {
      trimRecoveryHistory(url);
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

      if (!transparent && !terminalReview) {
        // The native review uses a terminal-coloured backing page, not a website.
        // Inject white background as a user stylesheet.
        // This ensures sites without explicit backgrounds are legible,
        // but allows site-defined backgrounds to take precedence.
        content.webContents.insertCSS('html { background-color: white; }', { cssOrigin: 'user' });
      }

      // Load and apply saved zoom for navigated origin
      try {
        const url = getAddress();
        const origin = new URL(url).origin;
        const savedZoom = getZoomFactor(origin);
        view.content.webContents.setZoomFactor(savedZoom);
        view.toolbar.webContents.send('content:zoom-changed', savedZoom);
      } catch {}
    });

    // Reflect the page title in the terminal window title so Kitty tabs show the current site.
    if (terminal?.output.setTitle) {
      content.webContents.on('page-title-updated', (_event, title) => {
        terminal.output.setTitle(title);
      });
    }

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

      if (noPaint || !isActive()) return;

      // Inactive tabs keep cached images, but their placements must not show
      // through the selected tab when Kitty dims an unfocused split.
      (graphics?.clearPlacements ?? clearPlacements)();

      if (hasAnimation) {
        // Kitty canvas dimensions are device pixels. Chromium paints at the
        // layout's device scale, which can exceed the terminal's logical size.
        size = {
          width: Math.max(size.width, contentNode.deviceLayout.x + contentNode.deviceLayout.width, toolbarNode.deviceLayout.x + toolbarNode.deviceLayout.width),
          height: Math.max(size.height, contentNode.deviceLayout.y + contentNode.deviceLayout.height, toolbarNode.deviceLayout.y + toolbarNode.deviceLayout.height),
        };
        // Content layer (z=0)
        const contentBuffer = new ShmGraphicBuffer(size.width * size.height * 4);
        // Base canvas in the terminal background so uncovered gaps match the split.
        contentBuffer.write(Buffer.alloc(size.width * size.height * 4).fill(coverPixel(terminal, Boolean(terminalReview))), size.width);
        out.placeCursor({ x: 0, y: 0 });
        const contentFrame = (graphics?.paintInitialFrame ?? paintInitialFrame)(
          contentBuffer,
          size,
          {
            z: 0,
          },
        );
        // Blend before Kitty dims inactive splits; separate placements become translucent independently.
        const cRef = registerPaintedContent(contentFrame, content, contentNode, terminal, isActive,
          undefined, { window: toolbar, layout: toolbarNode });

        destructors.push(cRef.destroy, contentFrame.free);
        refreshers.push(cRef.refresh);
      } else {
        const tRef = registerPaintedContentFallback(
          toolbar,
          toolbarNode,
          1,
          {
            replacePlacement: true,
          },
          terminal,
          isActive,
        );
        const cRef = registerPaintedContentFallback(
          content,
          contentNode,
          undefined,
          {
            replacePlacement: windowOptions.adbMode,
          },
          terminal,
          isActive,
          true,
        );
        destructors.push(tRef.destroy, cRef.destroy);
        refreshers.push(tRef.refresh, cRef.refresh);
      }
    }

    registerPaints(padSize(size));

    function loadToolbarContent() {
      if (toolbarLoaded) return;
      toolbarLoaded = true;
      if (options.dev) {
        toolbar.webContents.loadURL(`http://localhost:${TOOLBAR_PORT}?terminalScheme=${terminal?.identity.terminalScheme ?? 'dark'}&terminalBackground=${encodeURIComponent(terminal?.identity.terminalBackground ?? '')}`);
      } else {
        resetForFrameQuirk(toolbar.webContents);
        toolbar.webContents.loadFile(path.join(assetDirectory, 'toolbar/index.html'), {
          query: { terminalScheme: terminal?.identity.terminalScheme ?? 'dark', terminalBackground: terminal?.identity.terminalBackground ?? '' },
        });
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
    content.webContents.loadURL(terminalReview ? 'about:blank' : initialUrl);

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
    // Toolbar motion paints through this surface; it still paints only on change.
    toolbar.webContents.setFrameRate(60);

    content.webContents.setMaxListeners(30);

    const cursorHandler = createCursorUpdater(out.write);
    toolbar.webContents.on('cursor-changed', cursorHandler);
    content.webContents.on('cursor-changed', cursorHandler);

    toolbar.focusOnWebView = () => {
      if (!isActive()) return;
      if (!terminal) focusedView.current = view;
      view.focusedContent = toolbar.webContents;
      toolbar.focus();
      toolbar.webContents.focus();
    };
    content.focusOnWebView = () => {
      if (!isActive()) return;
      if (!terminal) focusedView.current = view;
      view.focusedContent = content.webContents;
      content.focus();
      content.webContents.focus();
    };

    toolbar.blurWebView = () => {};
    content.blurWebView = () => {};

    // Handle new window requests — allow popups for OAuth (preserves window.opener)
    const handleNewWindow = ({
      url,
      features,
      disposition,
    }: {
      url: string;
      features: string;
      disposition?: string;
    }) => {
      try {
        // A plain link to a new tab (no popup features) becomes a tab in this pane.
        // Anything sized like a popup stays native so OAuth keeps window.opener.
        // Only a local page may open a local file: a tab is loaded by the main process,
        // which would bypass Chromium's block on web pages linking to file: URLs.
        const fromLocalPage = /^file:/i.test(content.webContents.getURL());
        if (
          !features &&
          (disposition === 'foreground-tab' || disposition === 'background-tab') &&
          (/^https?:/i.test(url) || (fromLocalPage && /^file:/i.test(url)))
        ) {
          if (view.terminal?.actions) view.terminal.actions.newWindow(url);
          else createNewWindow(url);
          return { action: 'deny' as const };
        }
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
              sandbox: true,
              contextIsolation: true,
              nodeIntegration: false,
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
    let relayoutForced = false;
    let designResizeTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingResizeWidth = -1;
    let pendingResizeHeight = -1;
    let lastWidth = size.width;
    let lastHeight = size.height;

    const initialSourceWindowId = terminal
      ? (terminal.identity.sourceWindowId ?? null)
      : options['source-window-id']
        ? String(options['source-window-id']).trim()
        : process.env.AWRIT_SOURCE_WINDOW_ID || process.env.KITTY_WINDOW_ID || null;

    const view: WindowView = {
      get destroyed() {
        return destroyed;
      },
      onCopyToClipboard: windowOptions.onCopyToClipboard,
      terminal,
      adbMode: !!windowOptions.adbMode,
      adbSerial: windowOptions.adbSerial,
      toolbar,
      content,
      binding: {
        state: initialSourceWindowId ? 'orphaned' : 'unattached',
        sourceWindowId: initialSourceWindowId,
      },
      focusedContent: content.webContents,
      layoutContainer,
      toolbarLayoutContainer,
      toolbarNode,
      contentNode,
      omniboxVisible,
      findVisible: false,
      designMode: design,
      permissionPending: false,
      siteInfoOpen: false,
      keyHelpVisible: false,
      inputFocused: false,
      adbControlsVisible: false,
      adbServerUrl: windowOptions.adbServerUrl,
      startSuppression,
      stopSuppression,
      refresh() {
        refreshers.forEach((r) => {
          r();
        });
      },
      relayout(force = false) {
        relayoutForced ||= force;
        if (terminalReview && this.designMode && !relayoutForced) {
          try {
            const current = terminal?.size ?? getWindowSize();
            if (!designResizePending && current.width === lastWidth && current.height === lastHeight) return;
            if (designResizePending && current.width === pendingResizeWidth && current.height === pendingResizeHeight) return;
            pendingResizeWidth = current.width;
            pendingResizeHeight = current.height;
          } catch (error) {
            console_.error('Failed to get window size:', error);
            return;
          }
        }
        if (designResizeTimer !== undefined) {
          clearTimeout(designResizeTimer);
          designResizeTimer = undefined;
          designResizePending = false;
        }
        if (terminalReview && this.designMode && !relayoutForced) {
          designResizePending = true;
          // Resize the review immediately; only source exposure/recapture
          // waits until the drag stops. Kitty can only screenshot a visible
          // source, so each recapture briefly uncovers it; one recapture per
          // drag keeps that to a single blink.
          designResizeTimer = setTimeout(() => {
            designResizeTimer = undefined;
            designResizePending = false;
            if (!destroyed && this.designMode) void requestTerminalRefresh();
          }, 300);
        }
        if (relayoutScheduled) return;
        relayoutScheduled = true;
        setImmediate(() => {
          if (destroyed) return;
          relayoutScheduled = false;
          const force = relayoutForced;
          relayoutForced = false;
          let newSize: WindowSize;
          try {
            newSize = terminal?.size ?? getWindowSize();
          } catch (e) {
            console_.error('Failed to get window size:', e);
            return;
          }

          if (newSize.width <= 0 || newSize.height <= 0) return;
          if (!force && newSize.width === lastWidth && newSize.height === lastHeight) return;
          const oldDestructors = [...destructors];
          destructors.length = 0;

          // Keep the terminal's previous frame until the full replacement,
          // including cached pixels and old-image retirement, is submitted.
          out.startBatch();
          out.setModes([defaultOutput.Mode.pendingUpdate], true);
          try {
            updateViewSizes(this, newSize);
            windowOptions.onResize?.(newSize);
            registerPaints(padSize(newSize));
            lastWidth = newSize.width;
            lastHeight = newSize.height;
          } catch (error) {
            // A partial replacement must not prevent a same-size retry.
            lastWidth = lastHeight = -1;
            for (const destructor of destructors.splice(0)) destructor();
            refreshers.length = 0;
            console_.error('Failed to relayout:', error);
            return;
          } finally {
            try {
              for (const destructor of oldDestructors) destructor();
            } finally {
              out.setModes([defaultOutput.Mode.pendingUpdate], false);
              out.endBatch();
            }
          }

          toolbar.webContents.invalidate();
          content.webContents.invalidate();

          if (this.designMode || this.omniboxVisible || this.findVisible) view.toolbar.focusOnWebView();
          else view.content.focusOnWebView();
        });
      },
      toggleOmnibox() {
        this.omniboxVisible = !this.omniboxVisible;
        if (!this.designMode) this.content.webContents.invalidate();
        const sendTabs = () => {
          const tabs = this.terminal?.actions?.list();
          if (this.omniboxVisible && tabs) this.toolbar.webContents.send('omnibox:set-tabs', tabs);
        };

        if (this.omniboxVisible) {
          if (this.keyHelpVisible) this.toggleKeyHelp();
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
            sendTabs();
          }
        };

        // Wait for load to finish if we just loaded it
        if (this.omniboxVisible && this.toolbar.webContents.isLoading()) {
          this.toolbar.webContents.once('did-finish-load', () => {
            sendSignal();
            setTimeout(sendSignal, 100);
          });
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
        if (terminalReview && this.designMode) {
          terminal?.actions?.closeTab();
          return;
        }
        this.designMode = !this.designMode;
        console_.log(`[Design Mode] ${this.designMode ? 'ENABLED' : 'DISABLED'}`);

        const sendDesignModeSignal = () => {
          if (!this.toolbar.webContents.isLoading()) {
            this.toolbar.webContents.send('awrit:design-mode-changed', this.designMode);
          }
        };

        if (this.designMode) {
          // Freeze frame: capture visible viewport before gating paint
          (this.content as any).isSuppressingPaint = true;
          loadToolbarContent();

          const captureAndSend = () => {
            // The frozen frame must not include the agent's cursor.
            const wc = this.content.webContents;
            withoutAgentPreview(wc, () => wc.capturePage())
              .then(async (img) => {
                // Guard against race if designMode was exited while capturePage was pending
                if (!this.designMode || this.destroyed) return;
                const png = img.toPNG();
                const captureId = `cap-${crypto.randomBytes(6).toString('hex')}`;
                const captureSha256 = crypto.createHash('sha256').update(png).digest('hex');
                const pngDims = { width: img.getSize().width, height: img.getSize().height };
                currentCaptureMeta = { captureId, captureSha256, pngDims };

                const codeSource = this.adbMode ? undefined : await readCodeSource(this.content.webContents.getURL());
                if (!this.designMode || this.destroyed || currentCaptureMeta?.captureId !== captureId) return;
                const source = codeSource ?? (this.adbMode
                    ? {
                        kind: 'adb' as const,
                        serial: this.adbSerial || 'emulator',
                        ...((this as any).adbPackageName
                          ? { packageName: (this as any).adbPackageName }
                          : {}),
                      }
                    : {
                        kind: 'web' as const,
                        url: this.content.webContents.getURL() || 'about:blank',
                        title: this.content.webContents.getTitle() || 'Web View',
                      });
                currentCaptureMeta.source = source;
                const sendFrame = () => {
                  if (!this.designMode || this.destroyed || currentCaptureMeta?.captureId !== captureId) return;
                  this.toolbar.webContents.send('awrit:design-frozen-frame', {
                    png,
                    width: pngDims.width,
                    height: pngDims.height,
                    captureId,
                    captureSha256,
                    source,
                  });
                };

                if (this.toolbar.webContents.isLoading()) {
                  this.toolbar.webContents.once('did-finish-load', sendFrame);
                } else {
                  sendFrame();
                }

                // Disk work comes after the frame is shown so the page does not look frozen.
                await new Promise((resolve) => setImmediate(resolve));
                // Persist frozen screenshot to ephemeral session workspace so agents can inspect it
                try {
                  const session = initSessionWorkspace();
                  const sessionPngPath = path.join(session.dir, `${captureId}.png`);
                  fs.writeFileSync(sessionPngPath, png, { mode: 0o600 });

                  // Also persist to global captures dir as backup
                  const capturesDir = path.join(getAppDataPath(), 'captures');
                  if (!fs.existsSync(capturesDir)) {
                    fs.mkdirSync(capturesDir, { recursive: true, mode: 0o700 });
                  }
                  const capPngPath = path.join(capturesDir, `${captureId}.png`);
                  fs.writeFileSync(capPngPath, png, { mode: 0o600 });
                } catch (e) {
                  console_.error('[Design] Failed to persist frozen capture PNG:', e);
                }
                try {
                  const snapshot = this.adbMode ? undefined : await readCodeSnapshot(this.content.webContents.getURL());
                  saveReviewCapture(png, captureId, source, snapshot);
                } catch (error) { console_.error('[Design] Failed to save design capture:', error); }
              })
              .catch((err) => {
                console_.error('Failed to capture page for design mode', err);
              });
          };

          captureAndSend();

          if (this.toolbar.webContents.isLoading()) {
            this.toolbar.webContents.once('did-finish-load', sendDesignModeSignal);
          } else {
            sendDesignModeSignal();
            setTimeout(sendDesignModeSignal, 50);
          }

          this.toolbar.setIgnoreMouseEvents(false);
          this.toolbar.focusOnWebView();
          this.toolbar.focus();
        } else {
          (this.content as any).isSuppressingPaint = false;
          // Re-registration during a suppressed resize may have no page buffer yet.
          this.content.webContents.invalidate();
          sendDesignModeSignal();
          this.toolbar.setIgnoreMouseEvents(
            !this.findVisible && !this.omniboxVisible && !this.keyHelpVisible,
          );
          this.content.focusOnWebView();
          this.content.focus();
        }

        this.content.webContents.send('awrit:set-design-mode', this.designMode);
      },
      toggleKeyHelp() {
        this.keyHelpVisible = !this.keyHelpVisible;

        if (this.keyHelpVisible) {
          if (this.omniboxVisible) this.toggleOmnibox();
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
        if (recoveryAddresses.has(currentUrl)) {
          content.webContents.loadURL(getAddress(currentUrl));
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
        if (designResizeTimer !== undefined) clearTimeout(designResizeTimer);
        ipcCleanup();
        stopToolbarDragAndDrop();
        stopContentDragAndDrop();
        stopContentFileChooser();
        stopListeners();
        stopToolbarHandlers();

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

    onFailure(() => {
      destroyed = true;
    });
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
        const failedUrl = getAddress(validatedURL);
        const html = generateErrorPage({ errorCode, errorDescription, failedUrl });
        showRecoveryPage(html, failedUrl);
      },
    );

    // Crash recovery: show a recovery page when the renderer process dies
    content.webContents.on('render-process-gone', (_event, details) => {
      console_.error(`[Crash] Renderer process gone: ${details.reason} (exit ${details.exitCode})`);
      const failedUrl = getAddress();
      const html = generateCrashPage({
        reason: details.reason,
        exitCode: details.exitCode,
        failedUrl,
      });
      showRecoveryPage(html, failedUrl);
    });

    // Log when page becomes unresponsive
    content.webContents.on('unresponsive', () => {
      console_.error('[Warning] Page has become unresponsive');
    });

    content.webContents.on('responsive', () => {
      console_.log('[Info] Page is responsive again');
    });

    onFailure(() => {
      const index = managedViews.indexOf(view);
      if (index !== -1) managedViews.splice(index, 1);
      if (focusedView.current === view) focusedView.current = null;
    });
    managedViews.push(view);
    if (!terminal) focusedView.current = view;

    const ipcCleanup = setupToolbarIPC(toolbar.webContents, content.webContents, view, getAddress);
    onFailure(ipcCleanup);

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
      if (destroyed || content.isDestroyed() || !isActive()) return;
      establishFocus();
      // Dummy event to wake up the event loop
      content.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 });
    };

    kickstart();
    content.webContents.on('did-finish-load', kickstart);

    // Multiple delays ensure focus sticks after internal Chromium readiness
    const kickstartTimers = [500, 1500, 3000].map((ms) => setTimeout(kickstart, ms));
    destructors.push(() => {
      for (const timer of kickstartTimers) clearTimeout(timer);
      content.webContents.removeListener('did-finish-load', kickstart);
    });

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
      const target = url.toString();
      const forward = windowOptions.onOpenExternal;
      if (forward) {
        forward(target);
        return;
      }
      void shell.openExternal(target).catch((error) => {
        console_.error('[Auth Bridge] Failed to open external URL:', error);
      });
    };

    const onCopyToClipboard = (event: IpcMainEvent, value: unknown) => {
      if (event.sender !== content.webContents || typeof value !== 'string') return;
      const forward = windowOptions.onCopyToClipboard;
      if (forward) {
        forward(value);
        return;
      }
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

    const onRetry = (event: IpcMainEvent) => {
      if (event.sender !== content.webContents) return;
      view.reload();
    };

    const onInputFocus = (event: IpcMainEvent, focused: unknown) => {
      if (event.sender !== content.webContents || typeof focused !== 'boolean') return;
      view.inputFocused = focused;
      view.toolbar.webContents.send('awrit:input-focus-changed', focused);
    };


    const onEnterDesignMode = (event: IpcMainEvent) => {
      if (event.sender !== toolbar.webContents || view.designMode) return;
      view.toggleDesignMode();
    };

    const onExitDesignMode = (event: IpcMainEvent) => {
      if (event.sender !== toolbar.webContents) return;
      if (terminalReview) {
        terminal?.actions?.closeTab();
        return;
      }
      if (view.designMode) {
        view.toggleDesignMode();
      }
    };

    const onInspectElementAtPoint = async (
      event: Electron.IpcMainInvokeEvent,
      x: unknown,
      y: unknown,
      up: unknown = 0,
    ) => {
      if (event.sender !== toolbar.webContents) {
        return null;
      }
      if (typeof up !== 'number' || !Number.isInteger(up) || up < 0 || up > 30) return null;
      if (
        typeof x !== 'number' ||
        typeof y !== 'number' ||
        !Number.isFinite(x) ||
        !Number.isFinite(y)
      ) {
        return null;
      }
      if (currentCaptureMeta?.restored || view.adbMode || !content || content.isDestroyed()) {
        return null;
      }

      try {
        // Both windows use CSS coordinates; display DPR cancels out. Only
        // their relative page zoom changes the coordinate mapping.
        const inspectionScale = content.webContents.getZoomFactor() / toolbar.webContents.getZoomFactor();
        const script = `
        (() => {
          try {
            const dpr = ${inspectionScale};
            const scaledX = ${x} / dpr;
            const scaledY = ${y} / dpr;
            const elements = document.elementsFromPoint ? document.elementsFromPoint(scaledX, scaledY) : [];
            let el = null;
            const winW = window.innerWidth || document.documentElement.clientWidth || 0;
            const winH = window.innerHeight || document.documentElement.clientHeight || 0;
            if (winW <= 0 || winH <= 0) return null;
            const totalViewportArea = winW * winH;

            // Pick the candidate with the smallest non-zero area under the cursor
            // This ensures we always highlight the most specific leaf element rather than large container wrappers.
            let minArea = Infinity;
            for (const cand of elements) {
              if (!cand || typeof cand !== 'object' || !('getBoundingClientRect' in cand)) continue;
              const r = cand.getBoundingClientRect();
              if (!Number.isFinite(r.left) || !Number.isFinite(r.top) || !Number.isFinite(r.width) || !Number.isFinite(r.height)) continue;
              if (r.width <= 0 || r.height <= 0) continue;
              const area = r.width * r.height;
              if (area < minArea) {
                minArea = area;
                el = cand;
              }
            }
            if (!el) {
              el = document.elementFromPoint(scaledX, scaledY);
            }
            if (!el || typeof el !== 'object' || !('getBoundingClientRect' in el)) return null;
            // Arrow keys in the overlay select an ancestor; stop below <body> so the whole page is never picked.
            for (let i = 0; i < ${up}; i++) {
              const parent = el.parentElement;
              if (!parent || parent === document.body || parent === document.documentElement) break;
              el = parent;
            }
            let rawTag = '';
            try {
              const desc = Object.getOwnPropertyDescriptor(Element.prototype, 'tagName');
              if (desc && typeof desc.get === 'function') {
                rawTag = desc.get.call(el);
              } else {
                rawTag = el.tagName;
              }
            } catch {
              rawTag = typeof el.tagName === 'string' ? el.tagName : '';
            }
            if (typeof rawTag !== 'string' || !rawTag) return null;
            const tag = rawTag.toLowerCase();
            const rect = el.getBoundingClientRect();
            if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return null;
            let selector = tag;
            const id = typeof el.getAttribute === 'function' ? el.getAttribute('id') : null;
            if (id) {
              selector += '#' + CSS.escape(id);
            } else if ('classList' in el && el.classList && typeof el.classList[Symbol.iterator] === 'function') {
              const classList = Array.from(el.classList).slice(0, 3);
              if (classList.length > 0) {
                selector += '.' + classList.map(c => CSS.escape(String(c))).join('.');
              }
            }
            // A bare tag.class selector often matches many elements; add position and parents until it is unique.
            try {
              const nth = (n) => {
                if (!n.parentElement) return '';
                const same = Array.from(n.parentElement.children).filter((c) => c.tagName === n.tagName);
                return same.length > 1 ? ':nth-of-type(' + (same.indexOf(n) + 1) + ')' : '';
              };
              if (document.querySelectorAll(selector).length > 1) {
                const parts = [selector + nth(el)];
                let node = el;
                for (let depth = 0; depth < 5 && node.parentElement && document.querySelectorAll(parts.join(' > ')).length > 1; depth++) {
                  node = node.parentElement;
                  const nodeTag = node.tagName.toLowerCase();
                  parts.unshift(node.id ? nodeTag + '#' + CSS.escape(node.id) : nodeTag + nth(node));
                  if (node.id) break;
                }
                selector = parts.join(' > ');
              }
            } catch {}
            let textSnippet = undefined;
            const typeAttr = typeof el.getAttribute === 'function' ? el.getAttribute('type') : null;
            if (typeAttr === 'password') {
              textSnippet = '••••••••';
            } else {
              const visible = typeof el.innerText === 'string' ? el.innerText : '';
              const rawText = visible ? visible.trim() : '';
              if (rawText) {
                const singleLine = rawText.replace(/\\s+/g, ' ');
                textSnippet = singleLine.length > 100 ? singleLine.slice(0, 97) + '...' : singleLine;
              }
            }

            if (typeAttr !== 'password' && typeof el.getAttribute === 'function') {
              // Controls with no visible text (icon buttons, inputs) are named by their label.
              const labelled = el.labels && el.labels[0] ? el.labels[0].innerText : '';
              const name = (el.getAttribute('aria-label') || labelled || el.getAttribute('alt') || el.getAttribute('title') || el.getAttribute('placeholder') || '').replace(/\\s+/g, ' ').trim();
              if (name && (!textSnippet || el.getAttribute('aria-label'))) textSnippet = name.length > 100 ? name.slice(0, 97) + '...' : name;
            }

            const roleAttr = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
            const implicitRoles = { a: 'link', button: 'button', select: 'combobox', textarea: 'textbox', img: 'image', nav: 'navigation', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', h5: 'heading', h6: 'heading', li: 'listitem', ul: 'list', ol: 'list', table: 'table', form: 'form' };
            const inputRoles = { checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', range: 'slider' };
            const role = (/^[a-z][a-z-]{0,39}$/.test(roleAttr || '') ? roleAttr : null) || (tag === 'input' ? (typeAttr === 'hidden' ? undefined : inputRoles[typeAttr || 'text'] || 'textbox') : (tag === 'a' && !el.hasAttribute('href')) ? undefined : implicitRoles[tag]) || undefined;

            const left = Math.max(0, Math.min(winW - 1, Math.round(rect.left)));
            const top = Math.max(0, Math.min(winH - 1, Math.round(rect.top)));
            const right = Math.max(left + 1, Math.min(winW, Math.round(rect.right || (rect.left + rect.width))));
            const bottom = Math.max(top + 1, Math.min(winH, Math.round(rect.bottom || (rect.top + rect.height))));
            const width = right - left;
            const height = bottom - top;
            if (width <= 0 || height <= 0) return null;

            // Map content coordinates back to toolbar coordinates via dpr
            const tbLeft = Math.round(left * dpr);
            const tbTop = Math.round(top * dpr);
            const tbWidth = Math.round(width * dpr);
            const tbHeight = Math.round(height * dpr);

            // The same six computed styles Cursor's Design Mode sends, so the agent sees what the page really renders.
            const cs = getComputedStyle(el);
            const styles = ['color', 'background-color', 'font-size', 'font-family', 'display', 'position']
              .map((name) => name + ': ' + cs.getPropertyValue(name).replace(/\\s+/g, ' ').trim())
              .join('; ').slice(0, 300);

            // Best-effort framework component name. Page objects are untrusted: read plain strings only.
            let component = '';
            const nameOf = (v) => (typeof v === 'string' ? v.replace(/[\\u0000-\\u001f\\u007f]+/g, ' ').trim().slice(0, 60) : '');
            try {
              const fiberKey = Object.keys(el).find((k) => k.startsWith('__reactFiber$'));
              if (fiberKey) {
                for (let f = el[fiberKey], n = 0; f && n < 50 && !component; f = f.return, n++) {
                  const t = f.type;
                  if (t && (typeof t === 'function' || typeof t === 'object')) {
                    const name = nameOf(t.displayName || t.name);
                    if (name.length > 1) component = name;
                  }
                }
              }
              if (!component && el.__vueParentComponent) component = nameOf(el.__vueParentComponent.type?.name || el.__vueParentComponent.type?.__name);
              if (!component && el.__vue__) component = nameOf(el.__vue__.$options?.name);
              if (!component && el.__svelte_meta) component = nameOf(String(el.__svelte_meta.loc?.file || '').split('/').pop()).replace(/\\.svelte$/, '');
            } catch {}

            return {
              elementId: tag + '-' + tbLeft + '-' + tbTop,
              tag,
              component: component || undefined,
              selector,
              textSnippet,
              role,
              styles,
              bounds: {
                x: tbLeft,
                y: tbTop,
                width: tbWidth,
                height: tbHeight,
              },
            };
          } catch (e) {
            return null;
          }
        })()
      `;
        return await content.webContents.executeJavaScript(script, true);
      } catch {
        return null;
      }
    };

    onFailure(stopListeners);
    onFailure(stopToolbarHandlers);
    listen('awrit:open-external', onOpenExternal);
    listen('awrit:copy-to-clipboard', onCopyToClipboard);
    listen('awrit:go-back', onGoBack);
    listen('awrit:retry', onRetry);
    listen('awrit:input-focus', onInputFocus);
    listen('awrit:exit-design-mode', onExitDesignMode);
    listen('awrit:enter-design-mode', onEnterDesignMode);
    registerToolbarHandler(
      'awrit:inspect-element-at-point',
      toolbarContentsId,
      onInspectElementAtPoint,
    );
    const designIpc = registerDesignIpc({
      toolbar,
      content,
      toolbarContentsId,
      view,
      terminal,
      terminalReview,
      onCopyToClipboard: windowOptions.onCopyToClipboard,
      out,
      sourceWindowIdOption: options['source-window-id'],
      loadToolbarContent,
      listen,
      registerToolbarHandler,
      isDestroyed: () => destroyed,
      getCaptureMeta: () => currentCaptureMeta,
      setCaptureMeta: (meta) => {
        currentCaptureMeta = meta;
      },
    });
    requestTerminalRefresh = designIpc.requestTerminalRefresh;
    function onAdbControlsVisible(event: Electron.IpcMainEvent, visible: unknown) {
      if (
        event.sender === content.webContents &&
        event.senderFrame === content.webContents.mainFrame &&
        typeof visible === 'boolean' &&
        view.adbServerUrl &&
        event.sender.getURL() === view.adbServerUrl
      ) {
        view.adbControlsVisible = visible;
      }
    }
    listen('awrit:adb-controls-visible', onAdbControlsVisible);

    toolbar.webContents.on('did-finish-load', () => {
      // Send the correct initial state to the toolbar to prevent desync
      toolbar.webContents.send('content:url-changed', getAddress());
      toolbar.webContents.send('omnibox:set-visible', view.omniboxVisible);
      toolbar.webContents.send('awrit:input-focus-changed', view.inputFocused);
      toolbar.webContents.send('content:zoom-changed', content.webContents.getZoomFactor());
      toolbar.webContents.send('awrit:design-mode-changed', view.designMode);
    });

    if (view.omniboxVisible) loadToolbarContent();
    designIpc.initializeTerminalReview();

    // Trigger an initial relayout to ensure focus and size are perfectly synced
    setImmediate(() => {
      if (!destroyed) {
        view.relayout(true);
        // Prime the renderer with a dummy mouse event to wake up the event loop
        content.webContents.sendInputEvent({ type: 'mouseMove', x: 0, y: 0 });
      }
    });

    return view;
  });
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
  getAddress: (url?: string) => string,
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
    'toolbar:select-tab': (_event: unknown, index: number) => {
      const actions = view.terminal?.actions;
      if (!view.omniboxVisible || !actions || !Number.isInteger(index) || index < 0 || index >= actions.list().length) return;
      view.toggleOmnibox();
      actions.select(index);
    },
    'toolbar:close-tab-at': (_event: unknown, index: number) => {
      const actions = view.terminal?.actions;
      if (!view.omniboxVisible || !actions || !Number.isInteger(index) || index < 0) return;
      actions.closeTabAt(index);
      const tabs = actions.list();
      if (view.omniboxVisible && tabs.length) view.toolbar.webContents.send('omnibox:set-tabs', tabs);
    },
    'toolbar:site-info-open': (_event: unknown, open: boolean) => {
      view.siteInfoOpen = open === true;
    },
    'toolbar:toggle-find': () => view.toggleFind(),
    'toolbar:close': () => {
      if (view.omniboxVisible) view.toggleOmnibox();
      if (view.findVisible) view.toggleFind();
    },
    'toolbar:open-in-new-window': (_e: any, url: string) => {
      if (view.terminal?.actions) view.terminal.actions.newWindow(url);
      else createNewWindow(url);
    },
    'omnibox:escape': () => {
      if (view.omniboxVisible) view.toggleOmnibox();
      if (view.findVisible) view.toggleFind();
    },
    'toolbar:set-zoom': (_e: any, factor: number) => {
      const clamped = Math.min(3, Math.max(0.5, factor));
      contentContents.setZoomFactor(clamped);
      sendToolbar('content:zoom-changed', clamped);
      try {
        const origin = new URL(getAddress()).origin;
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

  // Timers can fire after the window closes; sending to a destroyed page throws.
  const sendToolbar = (channel: string, ...args: unknown[]) => {
    if (!toolbarContents.isDestroyed()) toolbarContents.send(channel, ...args);
  };

  let progressInterval: NodeJS.Timeout | null = null;
  let currentProgress = 0;
  let saveTimer: NodeJS.Timeout | null = null;
  let settleTimer: NodeJS.Timeout | null = null;

  const onPageZoomKey = (event: Electron.Event, input: Electron.Input) => {
    if (input.type !== 'keyDown' || input.alt || (!input.control && !input.meta) || view.designMode || contentContents.isDestroyed()) return;
    if (!['+', '=', '-', '_', '0'].includes(input.key)) return;
    event.preventDefault();
    const current = contentContents.getZoomFactor();
    const factor = input.key === '0' ? 1 : current + (input.key === '-' || input.key === '_' ? -0.1 : 0.1);
    handlers['toolbar:set-zoom'](event, Math.round(factor * 10) / 10);
  };
  contentContents.on('before-input-event', onPageZoomKey);

  const startProgress = () => {
    if (progressInterval) clearInterval(progressInterval);
    // Signal an indeterminate state first (negative value) so the toolbar can
    // show the sliding sliver before any real progress numbers arrive.
    sendToolbar('content:loading-progress', -1);
    currentProgress = 5;
    sendToolbar('content:loading-progress', currentProgress);
    progressInterval = setInterval(() => {
      if (currentProgress < 90) {
        currentProgress += Math.max(1, (90 - currentProgress) / 15);
        sendToolbar('content:loading-progress', Math.round(currentProgress));
      }
    }, 100);
  };

  const stopProgress = () => {
    if (progressInterval) {
      clearInterval(progressInterval);
      progressInterval = null;
    }
    sendToolbar('content:loading-progress', 100);
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(
      () => !progressInterval && sendToolbar('content:loading-progress', 0),
      300,
    );
  };

  const onLoadingStarted = () => {
    sendToolbar('content:loading-started');
    startProgress();
  };
  const onLoadingStopped = () => {
    sendToolbar('content:loading-stopped');
    sendToolbar('content:loading-url', ''); // Clear loading URL on stop
    stopProgress();
  };
  const onDidNavigate = (_e: any, url: string) => {
    sendToolbar('content:url-changed', getAddress(url));
    updateNavigationState();
  };
  const onDidNavigateInPage = (_e: any, url: string, isMainFrame: boolean) => {
    if (isMainFrame) {
      sendToolbar('content:url-changed', getAddress(url));
      updateNavigationState();
    }
  };

  const onUpdateTargetUrl = (_e: any, url: string) => {
    sendToolbar('content:update-target-url', url);
  };

  const onDidStartNavigation = (_e: any, url: string, isInPlace: boolean, isMainFrame: boolean) => {
    if (isMainFrame && !isInPlace) {
      sendToolbar('content:loading-url', getAddress(url));
    }
  };

  const onDidRedirectNavigation = (
    _e: any,
    url: string,
    isInPlace: boolean,
    isMainFrame: boolean,
  ) => {
    if (isMainFrame && !isInPlace) {
      sendToolbar('content:loading-url', getAddress(url));
    }
  };

  const updateNavigationState = () => {
    sendToolbar('content:navigation-state-changed', {
      canGoBack: contentContents.navigationHistory.canGoBack(),
      canGoForward: contentContents.navigationHistory.canGoForward(),
    });
  };

  contentContents.on('found-in-page', (_event, result) => {
    sendToolbar('toolbar:find-result', {
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
    if (!contentContents.isDestroyed()) contentContents.off('before-input-event', onPageZoomKey);
    if (saveTimer) clearTimeout(saveTimer);
    if (settleTimer) clearTimeout(settleTimer);
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
