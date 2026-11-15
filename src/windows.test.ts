import { expect, test } from 'bun:test';
import { console_ } from './console';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import FakeTimers from '@sinonjs/fake-timers';
import type { FeedbackPayload } from './ipc/feedbackDelivery';
import type { ConnectedClient, IpcServer } from './ipc/socketServer';
import { createDesignIpcHarness, fakeWindowView, type DesignIpcHarness } from './design/windowDesignIpcHarness';

test('navigation loading callbacks cannot extend the 200 ms paint freeze', () => {
  const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('  let suppressionTimeout:'),
    source.indexOf("  content.on('content-ready'"),
  );
  const javascript = block.replace(/: NodeJS.Timeout \| null/g, '');
  const content = {
    isSuppressingPaint: false,
    paintCount: 0,
    setBackgroundColor() {},
    once() {},
    isDestroyed: () => false,
    webContents: { invalidate() {}, isLoading: () => true, isDestroyed: () => false },
  };
  const context = vm.createContext({
    content,
    destructors: [],
    transparent: false,
    terminalReview: undefined, terminal: undefined,
    Date,
    setTimeout,
    clearTimeout,
  });
  const clock = FakeTimers.withGlobal(context).install({
    toFake: ['Date', 'setTimeout', 'clearTimeout'],
  });
  try {
    vm.runInContext(javascript, context);
    vm.runInContext('startSuppression(); stopSuppression(1000);', context);
    clock.tick(199);
    expect(content.isSuppressingPaint).toBe(true);
    clock.tick(1);
    expect(content.isSuppressingPaint).toBe(false);
    vm.runInContext('startSuppression(); popupActive = true;', context);
    clock.tick(200);
    expect(content.isSuppressingPaint).toBe(true);
    vm.runInContext('popupActive = false; stopSuppression(1000);', context);
    clock.tick(0);
    expect(content.isSuppressingPaint).toBe(false);
  } finally {
    clock.uninstall();
  }
});

test('recovery addresses follow history without changing ordinary data pages', () => {
  const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('  const recoveryAddresses ='),
    source.indexOf('  let suppressionTimeout:'),
  );
  let currentUrl = 'https://example.com/';
  let entries: { url: string }[] = [];
  const sent: [string, string][] = [];
  const context = vm.createContext({
    content: {
      webContents: {
        getURL: () => currentUrl,
        navigationHistory: { getAllEntries: () => entries },
        loadURL: (url: string) => {
          currentUrl = url;
          entries.push({ url });
        },
        reload: () => sent.push(['reload', currentUrl]),
      },
    },
    toolbarContents: { send: (channel: string, url: string) => sent.push([channel, url]) },
    sendToolbar: (channel: string, url: string) => sent.push([channel, url]),
    updateNavigationState() {},
    startSuppression() {},
  });
  const transpiler = new Bun.Transpiler({ loader: 'ts' });
  const run = (code: string) => vm.runInContext(transpiler.transformSync(code), context);
  run(block);
  run("showRecoveryPage('A', 'https://a.invalid/');");
  const pageA = currentUrl;
  run("showRecoveryPage('B', 'https://b.invalid/');");
  expect(run('getAddress()')).toBe('https://b.invalid/');
  currentUrl = pageA;
  expect(run('getAddress()')).toBe('https://a.invalid/');
  currentUrl = 'data:text/html,user page';
  expect(run('getAddress()')).toBe(currentUrl);

  // Loading and completed navigation must never publish the recovery document URI.
  const events = source.slice(
    source.indexOf('  const onDidNavigate ='),
    source.indexOf('  const updateNavigationState ='),
  );
  run(events);
  currentUrl = pageA;
  run('onDidStartNavigation(null, content.webContents.getURL(), false, true);');
  run('onDidNavigate(null, content.webContents.getURL());');
  run('onDidNavigateInPage(null, content.webContents.getURL(), true);');
  run('onDidRedirectNavigation(null, content.webContents.getURL(), false, true);');
  expect(sent.map(([, url]) => url)).toEqual(Array(4).fill('https://a.invalid/'));

  const reload = source.slice(
    source.indexOf('    reload: () => {'),
    source.indexOf('    toggleDevTools:'),
  );
  run(`const reloadView = {${reload}};`);
  run('reloadView.reload();');
  expect(currentUrl).toBe('https://a.invalid/');
  currentUrl = 'data:text/html,user page';
  run('reloadView.reload();');
  expect(sent.at(-1)).toEqual(['reload', currentUrl]);

  // A replaced forward branch is pruned on the next recovery page.
  entries = [{ url: pageA }];
  run("showRecoveryPage('C', 'https://c.invalid/');");
  expect(run('recoveryAddresses.size')).toBe(2);
  expect(run('getAddress()')).toBe('https://c.invalid/');
  sent.length = 0;
  context.toolbar = { webContents: context.toolbarContents };
  context.view = { omniboxVisible: true, inputFocused: false };
  context.content.webContents.getZoomFactor = () => 1;
  const initialState = source
    .slice(
      source.indexOf("  toolbar.webContents.on('did-finish-load', () => {") +
        "  toolbar.webContents.on('did-finish-load', () => {".length,
      source.indexOf('  if (view.omniboxVisible) loadToolbarContent();'),
    )
    .replace(/\}\);\s*$/, '');
  run(initialState);
  expect(sent[0]).toEqual(['content:url-changed', 'https://c.invalid/']);
  expect(sent[1]).toEqual(['omnibox:set-visible', true]);
});

test('recovery pages replace failed entries so Back cannot loop', () => {
  const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('  const trimRecoveryHistory ='),
    source.indexOf('  let suppressionTimeout:'),
  );
  const recovery = 'data:text/html,recovery';
  const olderRecovery = 'data:text/html,older-error';
  let entries = ['https://broken.invalid/', olderRecovery, 'https://broken.invalid/', recovery];
  let active = 3;
  const context = vm.createContext({
    pendingRecoveryUrl: recovery,
    recoveryAddresses: new Map([
      [recovery, 'https://broken.invalid/'],
      [olderRecovery, 'https://broken.invalid/'],
    ]),
    content: {
      webContents: {
        navigationHistory: {
          getActiveIndex: () => active,
          getEntryAtIndex: (index: number) => ({ url: entries[index] }),
          removeEntryAtIndex: (index: number) => {
            if (index === active) return false;
            entries.splice(index, 1);
            if (index < active) active--;
            return true;
          },
        },
      },
    },
  });
  vm.runInContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(block), context);
  context.url = recovery;
  vm.runInContext('trimRecoveryHistory(url)', context);
  expect(entries).toEqual(['https://broken.invalid/', recovery]);
  expect(active).toBe(1);
  // Back revisiting an old recovery must preserve its preceding visit.
  entries = ['https://broken.invalid/', recovery];
  active = 1;
  context.url = recovery;
  vm.runInContext('trimRecoveryHistory(url)', context);
  expect(entries).toEqual(['https://broken.invalid/', recovery]);
  // Normal pages and data pages do not participate in cleanup.
  entries = ['https://example.com/', 'https://broken.invalid/'];
  context.url = 'https://broken.invalid/';
  vm.runInContext('trimRecoveryHistory(url)', context);
  expect(entries).toEqual(['https://example.com/', 'https://broken.invalid/']);
});

test('focus kickstart timers do nothing after the view is destroyed', () => {
  const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('  const kickstart = () => {'),
    source.indexOf('  const onOpenExternal'),
  );
  const calls: string[] = [];
  const context = vm.createContext({
    destroyed: false,
    isActive: () => true,
    establishFocus: () => calls.push('focus'),
    content: {
      isDestroyed: () => false,
      webContents: { on() {}, removeListener() {}, sendInputEvent: () => calls.push('mouse') },
    },
    destructors: [] as Array<() => void>,
    Date,
    setTimeout,
    clearTimeout,
  });
  const clock = FakeTimers.withGlobal(context).install({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    vm.runInContext(block, context);
    calls.length = 0;
    clock.tick(500);
    expect(calls.length).toBe(2);
    context.isActive = () => false;
    calls.length = 0;
    clock.tick(1000);
    expect(calls).toEqual([]);
    vm.runInContext('destructors.forEach((d) => d());', context);
    calls.length = 0;
    clock.tick(5000);
    expect(calls).toEqual([]);
    expect(clock.countTimers()).toBe(0);
  } finally {
    clock.uninstall();
  }
});

test('design feedback crops only for single annotation and preserves full frame for multi-annotation', async () => {
  const deliver = async (annotations: FeedbackNote[]) => {
    const send = await designSend();
    try {
      const captureDir = path.join(send.dataDir, 'awrit', 'captures');
      mkdirSync(captureDir, { recursive: true });
      writeFileSync(path.join(captureDir, `${SEND_CAPTURE_ID}.png`), Buffer.from('full frame'));
      const crops: string[] = [];
      send.harness.electron.setCreateFromBuffer((buffer) => ({
        isEmpty: () => false,
        getSize: () => ({ width: 100, height: 100 }),
        crop: (rect) => {
          crops.push(`${rect.x},${rect.y},${rect.width}x${rect.height}`);
          // The cropped bytes are what gets attached, so the delivered image proves the crop.
          return { toPNG: () => Buffer.from(`${buffer.toString()}+cropped`) };
        },
      }));
      expect(await send.send(feedbackDraft(annotations))).toMatchObject({ ok: true });
      const capturePath = send.sent[0]?.capturePath;
      if (typeof capturePath !== 'string') throw new Error('Delivered capture path missing');
      return { crops, image: readFileSync(capturePath).toString() };
    } finally {
      send.restore();
    }
  };

  // One note crops to its selected element or region.
  expect(await deliver([feedbackNote('one')])).toEqual({ crops: ['10,20,30x40'], image: 'full frame+cropped' });
  // Several notes keep the full frame so every note stays in context.
  expect(await deliver([feedbackNote('one'), feedbackNote('two')])).toEqual({ crops: [], image: 'full frame' });
  // No notes means nothing to crop to.
  expect(await deliver([])).toEqual({ crops: [], image: 'full frame' });
  // A boundary payload without an annotations array must not crop or crash.
  for (const annotations of [undefined, null]) {
    const send = await designSend();
    try {
      const captureDir = path.join(send.dataDir, 'awrit', 'captures');
      mkdirSync(captureDir, { recursive: true });
      writeFileSync(path.join(captureDir, `${SEND_CAPTURE_ID}.png`), Buffer.from('full frame'));
      const crops: string[] = [];
      send.harness.electron.setCreateFromBuffer((buffer) => ({
        isEmpty: () => false,
        getSize: () => ({ width: 100, height: 100 }),
        crop: (rect: { x: number; y: number; width: number; height: number }) => {
          crops.push(`${rect.x},${rect.y},${rect.width}x${rect.height}`);
          return { toPNG: () => Buffer.from(`${buffer.toString()}+cropped`) };
        },
      }));
      const draft = { ...feedbackDraft([feedbackNote('one')]), annotations: annotations as never };
      const result = (await send.send(draft)) as { ok: boolean; error?: string };
      expect(crops).toEqual([]);
      if (result.ok) {
        const capturePath = send.sent[0]?.capturePath;
        expect(readFileSync(String(capturePath)).toString()).toBe('full frame');
      } else {
        expect(result.error).toBeTruthy();
      }
    } finally {
      send.restore();
    }
  }
});

test('toolbar IPC never sends to a destroyed toolbar from a timer', () => {
  const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
  const ipc = source.slice(source.indexOf('function setupToolbarIPC('));
  // Loading-progress timers can fire after the window closes; only the guarded helper may send.
  expect(ipc.match(/toolbarContents\.send\(/g)).toHaveLength(1);
  expect(ipc).toContain('if (!toolbarContents.isDestroyed()) toolbarContents.send(channel');
});

 test('exiting design mode clears suppression before requesting a fresh page frame', () => {
  const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
  const start = source.indexOf('          (this.content as any).isSuppressingPaint = false;', source.indexOf('const sendDesignModeSignal ='));
  const end = source.indexOf('          sendDesignModeSignal();', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  const calls: string[] = [];
  const content = {
    isSuppressingPaint: true,
    webContents: { invalidate() { expect(content.isSuppressingPaint).toBe(false); calls.push('invalidate'); } },
  };
  const context = vm.createContext({ content });
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end).replaceAll('this.content', 'content'));
  vm.runInContext(javascript, context);
  expect(content.isSuppressingPaint).toBe(false);
  expect(calls).toEqual(['invalidate']);
});

test('offscreen content is never mapped then hidden before the first page paint', () => {
  const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
  // Mapping/unmapping a hidden Wayland window suppresses its initial paint events.
  // Native picker role initialization must not break ordinary page rendering.
  expect(source).not.toContain('content.showInactive()');
});

test('feedback reaches the clipboard only when no agent can receive it', async () => {
  const withAgent = await designSend();
  try {
    expect(await withAgent.send(feedbackDraft([feedbackNote('one')]))).toMatchObject({ ok: true });
    // A connected agent receives the notes, so the user's clipboard stays untouched.
    expect(withAgent.clipboard()).toEqual([]);
    expect(withAgent.terminalClipboard).toEqual([]);
  } finally {
    withAgent.restore();
  }

  const noAgent = await designSend({ agents: false });
  try {
    expect(await noAgent.send(feedbackDraft([feedbackNote('one')]))).toMatchObject({ ok: false, noConnectedAgent: true });
    expect(noAgent.clipboard()).toHaveLength(1);
    expect(noAgent.clipboard()[0]).toContain('feedback for one');
    expect(noAgent.terminalClipboard).toEqual(noAgent.clipboard());
  } finally {
    noAgent.restore();
  }

  const remote = await designSend({ agents: false, remote: true });
  try {
    const result = await remote.send(feedbackDraft([feedbackNote('one')]));
    // A remote pane never writes this host's clipboard; it hands the text to the owner.
    expect(result).toMatchObject({ ok: false, noConnectedAgent: true });
    expect(remote.clipboard()).toEqual([]);
    expect(remote.terminalClipboard).toEqual([]);
    expect(result.error).toContain('remote host');
  } finally {
    remote.restore();
  }
});

 test('paint suppression timers are cancelled on teardown and ignore destroyed windows', () => {
  const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
  const block = source.slice(source.indexOf('  let suppressionTimeout:'), source.indexOf("  content.on('content-ready'"));
  let destroyed = false;
  let invalidations = 0;
  let onClosed = () => {};
  const clock = FakeTimers.createClock();
  const context = vm.createContext({
    transparent: false, terminalReview: undefined, terminal: undefined, Date: clock.Date,
    setTimeout: clock.setTimeout.bind(clock), clearTimeout: clock.clearTimeout.bind(clock),
    content: { isDestroyed: () => destroyed, setBackgroundColor() {}, once(event: string, callback: () => void) { expect(event).toBe('closed'); onClosed = callback; },
      webContents: { isDestroyed: () => destroyed, invalidate() { if (destroyed) throw new Error('destroyed'); invalidations++; } } },
  });
  vm.runInContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(block), context);
  vm.runInContext('startSuppression(); stopSuppression(100);', context);
  destroyed = true;
  onClosed();
  expect(clock.countTimers()).toBe(0);
  expect(() => clock.tick(500)).not.toThrow();
  vm.runInContext('stopSuppression(0, true);', context);
  expect(invalidations).toBe(0);
 });

test('a plain link to a local page opens as a tab instead of a native window', () => {
  const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('    const handleNewWindow = ({'),
    source.indexOf('    toolbar.webContents.setWindowOpenHandler(handleNewWindow);'),
  );
  const opened: string[] = [];
  let pageUrl = 'file:///tmp/index.html';
  const context = vm.createContext({
    view: { terminal: { actions: { newWindow: (url: string) => opened.push(url) } } },
    createNewWindow: (url: string) => opened.push(url),
    content: { getContentSize: () => [800, 600], webContents: { getURL: () => pageUrl } },
    console_: { log() {} },
    path: require('node:path'),
    assetDirectory: '/assets',
  });
  vm.runInContext(
    `${new Bun.Transpiler({ loader: 'ts' }).transformSync(block)}\nglobalThis.handleNewWindow = handleNewWindow;`,
    context,
  );
  const request = (url: string, features = '') =>
    context.handleNewWindow({ url, features, disposition: 'foreground-tab' });

  expect(request('file:///tmp/page2.html')).toEqual({ action: 'deny' });
  expect(request('https://example.com/page2')).toEqual({ action: 'deny' });
  expect(opened).toEqual(['file:///tmp/page2.html', 'https://example.com/page2']);

  // A web page must not be able to open a local file in a tab.
  opened.length = 0;
  pageUrl = 'https://example.com/';
  expect(request('file:///etc/passwd').action).toBe('allow');
  expect(request('https://example.com/page2')).toEqual({ action: 'deny' });
  expect(opened).toEqual(['https://example.com/page2']);
  pageUrl = 'file:///tmp/index.html';

  opened.length = 0;
  for (const url of ['data:text/html,page', 'about:blank', 'javascript:void 0']) {
    expect(request(url).action).toBe('allow');
  }
  expect(request('https://accounts.example/', 'width=500,height=600')).toMatchObject({
    action: 'allow',
    overrideBrowserWindowOptions: { show: true },
  });
  expect(opened).toEqual([]);
});

test('retry reloads the failed address from main-process state, never the page URL', () => {
  const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
  const reloadBlock = source.slice(
    source.indexOf('      reload: () => {'),
    source.indexOf('      toggleDevTools: () => {'),
  );
  const retryStart = source.indexOf('    const onRetry =');
  const retryBlock = source.slice(retryStart, source.indexOf('    const onInputFocus =', retryStart));
  const recoveryUrl = 'data:text/html,recovery';
  const failedUrl = 'file:///tmp/page2.html';
  const loaded: string[] = [];
  const recoveryAddresses = new Map([[recoveryUrl, failedUrl]]);
  const content = {
    webContents: {
      getURL: () => recoveryUrl,
      loadURL: (url: string) => loaded.push(url),
      reload: () => loaded.push('reload'),
    },
  };
  const context = vm.createContext({
    recoveryAddresses,
    content,
    startSuppression() {},
    getAddress: (url: string) => recoveryAddresses.get(url) ?? url,
  });
  vm.runInContext(`const view = {${reloadBlock}};\nglobalThis.view = view;`, context);
  vm.runInContext(
    `${new Bun.Transpiler({ loader: 'ts' }).transformSync(retryBlock)}\nglobalThis.onRetry = onRetry;`,
    context,
  );

  context.onRetry({ sender: { other: true } }, 'javascript:alert(1)');
  expect(loaded).toEqual([]);
  context.onRetry({ sender: content.webContents }, 'javascript:alert(1)');
  expect(loaded).toEqual([failedUrl]);
});

test('a partial design send quotes the pin number the review shows', async () => {
  const send = await designSend();
  try {
    const first = feedbackNote('ann-1');
    const second = feedbackNote('ann-2');
    const third = feedbackNote('ann-3');
    // The saved review already numbers three pins; sending one must keep its number.
    expect(await send.save(feedbackDraft([first, second, third], SEND_CAPTURE_ID))).toMatchObject({ ok: true });
    expect(await send.send(feedbackDraft([third]))).toMatchObject({ ok: true });
    const summary = send.sent[0]?.summary;
    if (typeof summary !== 'string') throw new Error('Summary missing');
    expect(summary).toContain('• #3');
    expect(summary).not.toContain('• #1');
  } finally {
    send.restore();
  }
});

test('acknowledged design feedback is never reported as failed when recording it fails', async () => {
  const errors: string[] = [];
  const originalError = console_.error;
  console_.error = (...args: unknown[]) => { errors.push(args.map(String).join(' ')); };
  try {
    // No frozen capture exists here, so recording the sent notes fails after delivery.
    // The accepted draft is still saved: the two records are written separately, so one
    // failing never skips the other (the b1b70fd guarantee).
    const send = await designSend();
    try {
      expect(await send.send(feedbackDraft([feedbackNote('one')]))).toMatchObject({ ok: true });
      expect(send.harness.view.designMode).toBe(false);
      expect(Boolean(send.savedDraft())).toBe(true);
    } finally {
      send.restore();
    }
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('sent notes not recorded');
  } finally {
    console_.error = originalError;
  }

  // A draft that cannot even be saved is never delivered: the user gets an actionable
  // message instead of the raw filesystem error, and nothing is recorded as sent.
  const blocked = await designSend();
  try {
    mkdirSync(path.join(blocked.dataDir, 'awrit'), { recursive: true });
    writeFileSync(path.join(blocked.dataDir, 'awrit', 'design-drafts'), 'not a directory');
    const result = await blocked.send(feedbackDraft([feedbackNote('one')]));
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('could not be saved');
    expect(result.error).not.toContain('ENOTDIR');
    expect(blocked.harness.view.designMode).toBe(true);
    expect(blocked.sent).toEqual([]);
  } finally {
    blocked.restore();
  }

  const undelivered = await designSend({ delivery: { ok: false, error: 'Offline' } });
  try {
    expect(await undelivered.send(feedbackDraft([feedbackNote('one')]))).toMatchObject({
      ok: false,
      error: 'Offline',
    });
  } finally {
    undelivered.restore();
  }
});

type FeedbackNote = { id: string; comment: string; selection: { kind: 'region'; bounds: { x: number; y: number; width: number; height: number } } };

const SEND_CAPTURE_ID = 'cap-0123456789ab';

function feedbackNote(id: string): FeedbackNote {
  return {
    id,
    comment: `feedback for ${id}`,
    selection: { kind: 'region', bounds: { x: 10, y: 20, width: 30, height: 40 } },
  };
}

function feedbackDraft(annotations: FeedbackNote[], id = 'draft-abcdef12') {
  return {
    version: 1,
    id,
    captureId: SEND_CAPTURE_ID,
    captureSha256: 'a'.repeat(64),
    state: 'editing',
    source: { kind: 'web', url: 'https://example.test/' },
    annotations,
  };
}

interface DesignSend {
  harness: DesignIpcHarness;
  /** Payloads the fake agent received, in order. */
  sent: FeedbackPayload[];
  clipboard: () => string[];
  terminalClipboard: string[];
  dataDir: string;
  send: (draft: object) => Promise<{ ok: boolean; error?: string; noConnectedAgent?: boolean }>;
  save: (draft: object) => Promise<{ ok: boolean }>;
  /** The draft on disk, which is how a reviewed send records its final state. */
  savedDraft: () => { state?: string } | null;
  restore: () => void;
}

/** Real design IPC with a fake agent, a temp capture/draft store and no frozen capture. */
async function designSend(
  options: { delivery?: { ok: boolean; error?: string }; agents?: boolean; remote?: boolean } = {},
): Promise<DesignSend> {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'awrit-design-send-'));
  const dataHome = process.env.XDG_DATA_HOME;
  const runtimeDir = process.env.AWRIT_RUNTIME_DIR;
  process.env.XDG_DATA_HOME = dataDir;
  process.env.AWRIT_RUNTIME_DIR = dataDir;
  const sent: FeedbackPayload[] = [];
  const terminalClipboard: string[] = [];
  const remoteClipboard: string[] = [];
  const client: ConnectedClient = {
    harness: 'pi',
    windowId: 'source-1',
    feedbackAck: true,
    registeredAt: Date.now(),
    socket: { destroyed: false } as net.Socket,
  };
  const server: IpcServer = {
    socketPath: path.join(dataDir, 'ipc.sock'),
    broadcast: () => {},
    sendTo: () => 0,
    sendFeedback: async (_recipient, payload) => {
      sent.push(payload);
      return options.delivery ?? { ok: true };
    },
    onRequest: () => {},
    stop: async () => {},
    getClientCount: () => 1,
    getClients: () => (options.agents === false ? [] : [client]),
  };
  const harness = await createDesignIpcHarness({
    ipcServer: server,
    view: fakeWindowView({ binding: { sourceWindowId: 'source-1' }, designMode: true }),
    out: { write: () => {}, writeToTerminalClipboard: (text) => terminalClipboard.push(text) },
    onCopyToClipboard: options.remote ? (text) => remoteClipboard.push(text) : undefined,
  });
  harness.setCaptureMeta({
    captureId: SEND_CAPTURE_ID,
    captureSha256: 'a'.repeat(64),
    pngDims: { width: 100, height: 100 },
    source: { kind: 'web', url: 'https://example.test/' },
  });
  const clipboardStart = harness.electron.clipboard.written.length;
  const { loadDraft } = await import('./design/draftStore');
  return {
    harness,
    sent,
    clipboard: () => harness.electron.clipboard.written.slice(clipboardStart),
    terminalClipboard,
    dataDir,
    send: (draft) =>
      harness.invoke('awrit:send-design-feedback', draft) as Promise<{ ok: boolean; error?: string; noConnectedAgent?: boolean }>,
    save: (draft) => harness.invoke('awrit:save-design-draft', draft) as Promise<{ ok: boolean }>,
    savedDraft: () => loadDraft('draft-abcdef12', { width: 100, height: 100 }),
    restore: () => {
      if (dataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = dataHome;
      if (runtimeDir === undefined) delete process.env.AWRIT_RUNTIME_DIR;
      else process.env.AWRIT_RUNTIME_DIR = runtimeDir;
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
