import { mock } from 'bun:test';
import type { BrowserWindow } from 'electron';
import type { WindowView } from '../windows';
import type { IpcServer } from '../ipc/socketServer';
import { validateDesignDraft } from './validation';
import type { Annotation, FrozenSource } from './types';
type CodeSourceModule = typeof import('./codeSource');
type ReviewSessionModule = typeof import('./reviewSession');
import type { DesignCaptureMeta, WindowDesignIpc, WindowDesignIpcDeps } from './windowDesignIpc';

/**
 * Typed fakes for exercising the real `registerDesignIpc` handlers in tests.
 *
 * The design IPC module imports Electron's `ipcMain`, `clipboard` and
 * `nativeImage`, so the harness stubs Electron before importing it and then calls
 * the captured channel handlers with the payloads the toolbar sends.
 */

export type Handler = (...args: unknown[]) => unknown;

export interface SentMessage {
  channel: string;
  payload?: unknown;
}

interface Listener {
  handler: Handler;
  once: boolean;
}

/** Records listeners and runs them, honouring `once` like an EventEmitter. */
function createEmitter() {
  const listeners = new Map<string, Listener[]>();
  return {
    add(event: string, handler: Handler, once: boolean) {
      listeners.set(event, [...(listeners.get(event) ?? []), { handler, once }]);
    },
    emit(event: string, args: unknown[]) {
      const entries = listeners.get(event) ?? [];
      if (entries.some(entry => entry.once)) {
        listeners.set(event, entries.filter(entry => !entry.once));
      }
      for (const entry of entries) entry.handler(...args);
    },
    count: (event: string) => (listeners.get(event) ?? []).length,
  };
}

export interface FakeWebContents {
  id: number;
  /** Every `send` call, in order. */
  sent: SentMessage[];
  isDestroyed: () => boolean;
  destroy: () => void;
  send: (channel: string, payload?: unknown) => void;
  on: (event: string, handler: Handler) => void;
  once: (event: string, handler: Handler) => void;
  emit: (event: string, ...args: unknown[]) => void;
  /** Runs the queued `paint` listeners, like a decoded offscreen frame. */
  invalidate: () => void;
  getURL: () => string;
  getTitle: () => string;
  capturePage: () => Promise<never>;
  executeJavaScript: (code: string) => Promise<unknown>;
  isLoading: () => boolean;
  insertCSS: (css: string) => Promise<string>;
}

export function fakeWebContents(
  options: {
    id?: number;
    url?: string;
    title?: string;
    executeJavaScript?: (code: string) => Promise<unknown>;
  } = {},
): FakeWebContents {
  const emitter = createEmitter();
  const sent: SentMessage[] = [];
  let destroyed = false;
  return {
    id: options.id ?? 1,
    sent,
    isDestroyed: () => destroyed,
    destroy: () => {
      destroyed = true;
      emitter.emit('destroyed', []);
    },
    send: (channel, payload) => {
      sent.push({ channel, payload });
    },
    on: (event, handler) => emitter.add(event, handler, false),
    once: (event, handler) => emitter.add(event, handler, true),
    emit: (event, ...args) => emitter.emit(event, args),
    invalidate: () => emitter.emit('paint', []),
    getURL: () => options.url ?? 'https://example.test/',
    getTitle: () => options.title ?? 'Example',
    capturePage: () => Promise.reject(new Error('capturePage is not faked')),
    executeJavaScript: options.executeJavaScript ?? (async () => ''),
    isLoading: () => false,
    insertCSS: async () => '',
  };
}

/** One fake `BrowserWindow`: recorded webContents sends plus window lifecycle listeners. */
export interface FakeWindow {
  webContents: FakeWebContents;
  isDestroyed: () => boolean;
  on: (event: string, handler: Handler) => void;
  once: (event: string, handler: Handler) => void;
  emit: (event: string, ...args: unknown[]) => void;
  focus: () => void;
  focusOnWebView: () => void;
  setIgnoreMouseEvents: () => void;
  close: () => void;
}

export function fakeWindow(options: { webContents?: FakeWebContents } = {}): FakeWindow {
  const webContents = options.webContents ?? fakeWebContents();
  const emitter = createEmitter();
  let destroyed = false;
  return {
    webContents,
    isDestroyed: () => destroyed,
    on: (event, handler) => emitter.add(event, handler, false),
    once: (event, handler) => emitter.add(event, handler, true),
    emit: (event, ...args) => emitter.emit(event, args),
    focus: () => {},
    focusOnWebView: () => {},
    setIgnoreMouseEvents: () => {},
    close: () => {
      destroyed = true;
    },
  };
}

/** The `BrowserWindow` surface `registerDesignIpc` uses. */
export const asBrowserWindow = (window: FakeWindow): BrowserWindow => window as unknown as BrowserWindow;

/** Captures toolbar handler registrations plus channels registered through `listen`. */
export interface RecordingIpc {
  register: (channel: string, handler: Handler) => void;
  listen: (channel: string, handler: Handler) => void;
  /** Calls the handler registered for a toolbar channel, as its invoke would. */
  invoke: (channel: string, event: { sender: unknown }, ...args: unknown[]) => unknown;
  /** Calls a handler registered through the injected `listen`. */
  emit: (channel: string, ...args: unknown[]) => void;
  channels: () => string[];
}

export function createRecordingIpc(): RecordingIpc {
  const handlers = new Map<string, Handler>();
  const listened = new Map<string, Handler[]>();
  return {
    register: (channel, handler) => {
      handlers.set(channel, handler);
    },
    listen: (channel, handler) => {
      listened.set(channel, [...(listened.get(channel) ?? []), handler]);
    },
    invoke: (channel, event, ...args) => {
      const handler = handlers.get(channel);
      if (!handler) throw new Error(`No handler for ${channel}`);
      return handler(event, ...args);
    },
    emit: (channel, ...args) => {
      for (const handler of listened.get(channel) ?? []) handler(...args);
    },
    channels: () => [...handlers.keys()],
  };
}

/** The `WindowView` members the design IPC reads or writes. */
export interface FakeViewState {
  designMode: boolean;
  keyHelpVisible: boolean;
  permissionPending: boolean;
  omniboxVisible: boolean;
  binding?: { sourceWindowId?: string; clientSocket?: unknown };
  toggleDesignMode: () => void;
}

/** The `WindowView` surface the design IPC touches, without the rendering members. */
export const asWindowView = (view: FakeViewState): WindowView => view as unknown as WindowView;

export function fakeWindowView(overrides: Partial<FakeViewState> = {}): FakeViewState {
  const view: FakeViewState = {
    designMode: false,
    keyHelpVisible: false,
    permissionPending: false,
    omniboxVisible: false,
    toggleDesignMode: () => {
      view.designMode = !view.designMode;
    },
    ...overrides,
  };
  return view;
}

export interface FakeClipboard {
  writeText: (text: string) => void;
  written: string[];
}

export interface ElectronStubs {
  /** The fake global `ipcMain` the design IPC imports. */
  ipcMain: {
    on: (channel: string, handler: Handler) => void;
    removeListener: (channel: string, handler: Handler) => void;
    off: (channel: string, handler: Handler) => void;
    emit: (channel: string, ...args: unknown[]) => void;
  };
  clipboard: FakeClipboard;
  /** Swaps the image decoder behind `nativeImage`, so a test can drive cropping. */
  setCreateFromBuffer: (decode: (buffer: Buffer) => {
    isEmpty: () => boolean;
    getSize: () => { width: number; height: number };
    crop: (rect: { x: number; y: number; width: number; height: number }) => { toPNG: () => Buffer };
  }) => void;
}

let installed: ElectronStubs | undefined;

/**
 * Stubs Electron's `ipcMain`, `clipboard` and `nativeImage` once per test process.
 * Run before importing the design IPC module; Bun applies `mock.module` globally.
 */
export function installDesignIpcElectronStubs(): ElectronStubs {
  if (installed) return installed;
  const listeners = new Map<string, Handler[]>();
  const written: string[] = [];
  const remove = (channel: string, handler: Handler) => {
    listeners.set(channel, (listeners.get(channel) ?? []).filter(entry => entry !== handler));
  };
  const ipcMain = {
    on: (channel: string, handler: Handler) => {
      listeners.set(channel, [...(listeners.get(channel) ?? []), handler]);
    },
    removeListener: remove,
    off: remove,
    emit: (channel: string, ...args: unknown[]) => {
      for (const handler of listeners.get(channel) ?? []) handler(...args);
    },
  };
  const clipboard: FakeClipboard = {
    writeText: (text: string) => {
      written.push(text);
    },
    written,
  };
  let decode: (buffer: Buffer) => {
    isEmpty: () => boolean;
    getSize: () => { width: number; height: number };
    crop: (rect: { x: number; y: number; width: number; height: number }) => { toPNG: () => Buffer };
  } = () => ({
    isEmpty: () => true,
    getSize: () => ({ width: 0, height: 0 }),
    crop: () => ({ toPNG: () => Buffer.alloc(0) }),
  });
  mock.module('electron', () => ({
    ipcMain,
    clipboard,
    nativeImage: {
      createFromBuffer: (buffer: Buffer) => decode(buffer),
      createFromDataURL: () => decode(Buffer.alloc(0)),
    },
    BrowserWindow: class {},
    app: { getPath: () => '/tmp' },
  }));
  installed = {
    ipcMain,
    clipboard,
    setCreateFromBuffer: (next) => {
      decode = next;
    },
  };
  return installed;
}

export interface DesignIpcHarness {
  /** Fake window the IPC treats as `content`. */
  pane: FakeWindow;
  toolbar: FakeWindow;
  view: FakeViewState;
  ipc: RecordingIpc;
  electron: ElectronStubs;
  api: WindowDesignIpc;
  deps: WindowDesignIpcDeps;
  captureMeta: () => DesignCaptureMeta | null;
  setCaptureMeta: (meta: DesignCaptureMeta | null) => void;
  /** Handler for a toolbar channel, called as its invoke would be. */
  invoke: (channel: string, ...args: unknown[]) => unknown;
  /** Stops using this harness's `sourceReader` override. */
  dispose: () => void;
}

export interface HarnessOverrides extends Omit<Partial<WindowDesignIpcDeps>, 'view'> {
  view?: FakeViewState;
  /** Replaces the persisted-review reader so a test can control timing and payloads. */
  sessionLoader?: (id: string) => Promise<Awaited<ReturnType<ReviewSessionModule['loadReviewSession']>>>;
  /** Replaces IPC server discovery, e.g. with fake connected agents. */
  ipcServer?: IpcServer | null;
  /** Replaces the code-page reader so source validation can be held open. */
  sourceReader?: CodeSourceModule['readCodeSnapshot'];
}

type ReviewSession = NonNullable<Awaited<ReturnType<ReviewSessionModule['loadReviewSession']>>>;

/** A review session shaped like one `loadReviewSession` restores from disk. */
export function fakeReviewSession(
  overrides: {
    captureId?: string;
    width?: number;
    height?: number;
    annotations?: Annotation[];
    sentRevisions?: Record<string, string[]>;
  } = {},
): ReviewSession {
  const captureId = overrides.captureId ?? 'cap-0123456789ab';
  const width = overrides.width ?? 800;
  const height = overrides.height ?? 600;
  const source: FrozenSource = { kind: 'web', url: 'https://example.test/' };
  const draft = validateDesignDraft(
    {
      version: 1,
      id: captureId,
      captureId,
      captureSha256: 'a'.repeat(64),
      source,
      annotations: overrides.annotations ?? [],
      state: 'editing',
    },
    { width, height },
  );
  return {
    png: Buffer.alloc(0),
    width,
    height,
    captureId,
    captureSha256: draft.captureSha256,
    captureProvenance: undefined,
    source,
    snapshot: undefined,
    draft,
    sentRevisions: overrides.sentRevisions ?? {},
  };
}

type SourceReader = NonNullable<HarnessOverrides['sourceReader']>;
let sourceReaderOverride: SourceReader | undefined;
let sourceReaderMocked = false;

// Bun's `mock.module` stays in effect for every later test file in the run, so the
// replacement only uses the test reader while one is set and otherwise calls the real code.
async function useSourceReader(reader: SourceReader): Promise<void> {
  sourceReaderOverride = reader;
  if (sourceReaderMocked) return;
  const real = { ...(await import('./codeSource')) };
  mock.module('./codeSource', () => ({
    ...real,
    readCodeSnapshot: (...args: Parameters<typeof real.readCodeSnapshot>) =>
      (sourceReaderOverride ?? real.readCodeSnapshot)(...args),
  }));
  sourceReaderMocked = true;
}

async function loadDesignIpc() {
  installDesignIpcElectronStubs();
  return import('./windowDesignIpc');
}

/** Registers the real design IPC handlers against fake windows. */
export async function createDesignIpcHarness(overrides: HarnessOverrides = {}): Promise<DesignIpcHarness> {
  const electron = installDesignIpcElectronStubs();
  const { sessionLoader, ipcServer, sourceReader, view: viewOverride, ...depsOverride } = overrides;
  if (sessionLoader) {
    const real = await import('./reviewSession');
    mock.module('./reviewSession', () => ({ ...real, loadReviewSession: sessionLoader }));
  }
  if (ipcServer !== undefined) {
    const real = await import('../ipc/socketServer');
    mock.module('../ipc/socketServer', () => ({ ...real, getIpcServer: () => ipcServer }));
  }
  if (sourceReader) await useSourceReader(sourceReader);
  const { registerDesignIpc } = await loadDesignIpc();
  const recording = createRecordingIpc();
  const pane = fakeWindow({ webContents: fakeWebContents({ id: 1 }) });
  const toolbar = fakeWindow({ webContents: fakeWebContents({ id: 2 }) });
  const view = viewOverride ?? fakeWindowView();
  let captureMeta: DesignCaptureMeta | null = null;
  const deps: WindowDesignIpcDeps = {
    content: asBrowserWindow(pane),
    toolbar: asBrowserWindow(toolbar),
    toolbarContentsId: toolbar.webContents.id,
    view: asWindowView(view),
    terminal: undefined,
    terminalReview: undefined,
    onCopyToClipboard: undefined,
    out: { write: () => {}, writeToTerminalClipboard: () => {} },
    sourceWindowIdOption: undefined,
    loadToolbarContent: () => {},
    listen: recording.listen as unknown as WindowDesignIpcDeps['listen'],
    registerToolbarHandler: (channel, _sender, handler) =>
      recording.register(channel, handler as unknown as Handler),
    isDestroyed: () => pane.isDestroyed(),
    getCaptureMeta: () => captureMeta,
    setCaptureMeta: (next) => {
      captureMeta = next;
    },
    ...depsOverride,
  };
  const api = registerDesignIpc(deps);
  return {
    pane,
    toolbar,
    view,
    ipc: recording,
    electron,
    api,
    deps,
    captureMeta: () => captureMeta,
    setCaptureMeta: (next) => {
      captureMeta = next;
    },
    invoke: (channel, ...args) => recording.invoke(channel, { sender: toolbar.webContents }, ...args),
    dispose: () => {
      if (sourceReader && sourceReaderOverride === sourceReader) sourceReaderOverride = undefined;
    },
  };
}
