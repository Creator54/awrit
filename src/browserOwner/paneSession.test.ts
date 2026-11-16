import { expect, test } from 'bun:test';
import type { AdbServerInstance } from '../adb/adbControl';
import type { TerminalContext } from '../terminal/context';
import type { WindowView } from '../windows';
import { decodeAttach } from './attach';
import { createPaneSession, type PaneSessionDeps } from './paneSession';

const attach = {
  type: 'attach',
  version: 1,
  build: 'test-build',
  debugPort: 'disabled',
  url: 'https://example.com',
  settings: { overlay: false, design: false, transparent: false, noPaint: false, debugPaint: false },
  size: { width: 800, height: 600, cols: 80, rows: 30 },
  features: { keyboard: true, images: true, loadFrame: true, compositeFrame: true },
};
const companion = { text: 'Hello', layout: 'text-left' as const, columns: { text: 50, media: 50 } };

function fakePage(events: string[], destroy = () => events.push('page.destroy')): WindowView {
  // Only the members this pane touches; the rest of WindowView drives Electron windows.
  return {
    content: { webContents: { id: 1, on: () => {} } },
    toolbar: { webContents: { send: () => {} }, focusOnWebView: () => {} },
    relayout: () => {},
    destroy,
  } as unknown as WindowView;
}

function harness(events: string[], options: { extra?: Record<string, unknown>; destroy?: () => void; createWindow?: PaneSessionDeps['createWindow']; createAdbControl?: PaneSessionDeps['createAdbControl'] } = {}) {
  const request = decodeAttach({ ...attach, ...options.extra }, 'test-build');
  const agentPanes: PaneSessionDeps['agentPanes'] = new Map();
  // The profile session is opaque here; only its presence matters before the window opens.
  const fakeProfileSession = {} as unknown as Awaited<
    ReturnType<PaneSessionDeps['getProfileSession']>
  >;
  const stream = {
    url: 'http://127.0.0.1:1/stream',
    port: 1,
    device: 'phone',
    resize: () => {},
    stop: () => events.push('stream.stop'),
  } as unknown as AdbServerInstance;
  const terminal = {
    id: 'pane',
    size: request.size,
    acknowledgeGraphics: () => {},
    dispose: () => events.push('terminal.dispose'),
  };
  const deps: PaneSessionDeps = {
    connectionId: 'pane-1',
    build: 'test-build',
    socket: { destroyed: false, end: () => events.push('socket.end'), destroy: () => events.push('socket.destroy') },
    output: { writeOutput: () => true, writeControl: () => true },
    assetDirectory: '/tmp/awrit-assets',
    getConfig: () => ({ homepage: 'https://example.com' }),
    agentPanes,
    request,
    createTerminal: () => terminal as unknown as TerminalContext,
    createWindow: options.createWindow ?? (async () => fakePage(events, options.destroy)),
    createInputHandler: () => ({
      handleInput: () => false,
      setDismissOverlayHandler: () => {},
      dispose: () => events.push('handle.dispose'),
    }),
    getProfileSession: async () => fakeProfileSession,
    createAdbControl: options.createAdbControl ?? (async () => stream),
    createCompanionFile: () => ({
      filePath: '/tmp/awrit-companion/index.html',
      cleanup: () => events.push('companion.cleanup'),
    }),
  };
  return { session: createPaneSession(deps), agentPanes };
}

/** The attach chain awaits the profile session and the window, so settle microtasks. */
function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('close destroys the page, input handler and terminal once, in order', async () => {
  const events: string[] = [];
  const { session, agentPanes } = harness(events);
  await settle();
  expect(agentPanes.size).toBe(1);

  session.close();
  session.close();

  expect(events).toEqual(['handle.dispose', 'page.destroy', 'terminal.dispose']);
  expect(agentPanes.size).toBe(0);
});

test('close stops the Android stream and companion cleanup once', async () => {
  const android: string[] = [];
  const stream = harness(android, { extra: { android: { maxSize: 720 } } });
  await settle();
  stream.session.close();
  stream.session.close();
  expect(android).toEqual(['handle.dispose', 'page.destroy', 'stream.stop', 'terminal.dispose']);

  const files: string[] = [];
  const companionSession = harness(files, { extra: { companion } });
  await settle();
  companionSession.session.close();
  companionSession.session.close();
  expect(files).toEqual(['handle.dispose', 'page.destroy', 'companion.cleanup', 'terminal.dispose']);
});

test('close during asynchronous window creation destroys the late page without registering it', async () => {
  const events: string[] = [];
  let finish!: (page: WindowView) => void;
  const pending = new Promise<WindowView>(resolve => { finish = resolve; });
  const { session, agentPanes } = harness(events, { createWindow: () => pending });
  await settle();
  session.close();
  finish(fakePage(events));
  await settle();
  expect(events).toEqual(['terminal.dispose', 'page.destroy']);
  expect(agentPanes.size).toBe(0);
});

test('close during Android startup stops the late stream without creating a window', async () => {
  const events: string[] = [];
  let finish!: (stream: AdbServerInstance) => void;
  const pending = new Promise<AdbServerInstance>(resolve => { finish = resolve; });
  const { session, agentPanes } = harness(events, {
    extra: { android: { maxSize: 720 } },
    createAdbControl: () => pending,
    createWindow: async () => { throw new Error('closed session must not create a window'); },
  });
  session.close();
  finish({ stop: () => events.push('stream.stop') } as unknown as AdbServerInstance);
  await settle();
  expect(events).toEqual(['terminal.dispose', 'stream.stop']);
  expect(agentPanes.size).toBe(0);
});

test('a throwing teardown step still runs the rest and rethrows', async () => {
  const events: string[] = [];
  const { session } = harness(events, {
    extra: { android: { maxSize: 720 } },
    destroy: () => {
      throw new Error('destroy failed');
    },
  });
  await settle();

  expect(() => session.close()).toThrow('destroy failed');
  expect(events).toEqual(['handle.dispose', 'stream.stop', 'terminal.dispose']);
  expect(() => session.close()).not.toThrow();
});
