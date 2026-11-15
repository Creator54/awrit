import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startIpcServer, stopIpcServer } from '../ipc/socketServer';
import { startRemotePane } from '../remote/registry';
import {
  callOwnerTool,
  describeStatus,
  parseToolArgs,
  readStatus,
  runToolCommand,
} from './toolClient';

let dir = '';
afterEach(async () => {
  await stopIpcServer();
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

const savedEnv: [string, string | undefined][] = [];

/** Points the registry and socket lookup at temp paths; restored after each test. */
function setEnv(name: string, value: string) {
  if (!savedEnv.some(([key]) => key === name)) savedEnv.push([name, process.env[name]]);
  process.env[name] = value;
}

afterEach(() => {
  for (const [name, value] of savedEnv.splice(0)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

async function serverWith(handler: (req: Record<string, unknown>) => unknown) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-tool-'));
  const socketPath = path.join(dir, 's.sock');
  const server = await startIpcServer({ socketPath });
  server.onRequest('tool:call', async (req) => handler(req as Record<string, unknown>));
  return socketPath;
}

test('sends tool:call and returns the owner response', async () => {
  let seen: Record<string, unknown> = {};
  const socketPath = await serverWith((req) => {
    seen = req;
    return { ok: true, result: { clicked: true } };
  });
  const res = await callOwnerTool(
    socketPath,
    'click',
    { selector: '#go' },
    { sourceWindowId: '7' },
  );
  expect(res).toEqual({ ok: true, result: { clicked: true } });
  expect(seen.name).toBe('click');
  expect(seen.arguments).toEqual({ selector: '#go' });
  expect(seen.sourceWindowId).toBe('7');
});

test('rejects when no owner is listening', async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-tool-'));
  await expect(callOwnerTool(path.join(dir, 'none.sock'), 'snapshot', {}, {})).rejects.toThrow(
    'No running Awrit viewer',
  );
});

test('surfaces owner errors', async () => {
  const socketPath = await serverWith(() => {
    throw new Error('No matching active viewer pane');
  });
  await expect(callOwnerTool(socketPath, 'snapshot', {}, {})).rejects.toThrow(
    'No matching active viewer pane',
  );
});

test('never falls back to a viewer opened from another terminal window', async () => {
  const asked: unknown[] = [];
  const socketPath = await serverWith((req) => {
    asked.push(req.sourceWindowId);
    if (req.sourceWindowId === '86') throw new Error('No matching active viewer pane');
    return { ok: true, result: { url: 'https://other-window.example/' } };
  });
  const prev = { sock: process.env.AWRIT_IPC_SOCKET, win: process.env.KITTY_WINDOW_ID };
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (message: unknown) => errors.push(String(message));
  process.env.AWRIT_IPC_SOCKET = socketPath;
  process.env.KITTY_WINDOW_ID = '86';
  try {
    expect(await runToolCommand(['snapshot'])).toBe(1);
  } finally {
    console.error = originalError;
    if (prev.sock === undefined) delete process.env.AWRIT_IPC_SOCKET;
    else process.env.AWRIT_IPC_SOCKET = prev.sock;
    if (prev.win === undefined) delete process.env.KITTY_WINDOW_ID;
    else process.env.KITTY_WINDOW_ID = prev.win;
  }
  expect(asked).toEqual(['86']);
  expect(errors.join('\n')).toBe(
    'No viewer is open in this terminal window. Open one with: awrit show URL --mode split --json',
  );
});

test('parseToolArgs reads name, JSON input and pane flags', () => {
  expect(parseToolArgs(['click', '{"selector":"#a"}'])).toEqual({
    name: 'click',
    input: { selector: '#a' },
    target: {},
  });
  expect(parseToolArgs(['snapshot', '--pane', 'p1'])).toEqual({
    name: 'snapshot',
    input: {},
    target: { paneId: 'p1' },
  });
  expect(() => parseToolArgs(['click', '{bad'])).toThrow('Input must be a JSON object');
  expect(() => parseToolArgs(['click', '[1]'])).toThrow('Input must be a JSON object');
  expect(() => parseToolArgs([])).toThrow('Usage: awrit tool');
  expect(() => parseToolArgs(['click', '{}', 'extra'])).toThrow('Unexpected argument: extra');
  expect(() => parseToolArgs(['text', '--pane'])).toThrow('Missing value for --pane');
  expect(() => parseToolArgs(['--bogus', 'text'])).toThrow('Unknown option: --bogus');
  expect(() => parseToolArgs(['text', '--pane', 'p1', '--pane', 'p2'])).toThrow('--pane');
});

describe('runToolCommand usage errors', () => {
  const cases: [string[], string][] = [
    [[], 'Usage: awrit tool'],
    [['text', '--pane', '--bogus'], 'Missing value for --pane'],
    [['navigate', 'notjson'], 'Input must be a JSON object'],
    [['navigate', '[1]'], 'Input must be a JSON object'],
    [['click', '{}', 'extra'], 'Unexpected argument: extra'],
    [['text', '--pane'], 'Missing value for --pane'],
    [['--bogus', 'text'], 'Unknown option: --bogus'],
  ];

  test.each(cases)('rejects %j with exit 2', async (args, message) => {
    const errors: string[] = [];
    const logs: string[] = [];
    const originalError = console.error;
    const originalLog = console.log;
    console.error = (line: unknown) => errors.push(String(line));
    console.log = (line: unknown) => logs.push(String(line));
    try {
      expect(await runToolCommand(args)).toBe(2);
    } finally {
      console.error = originalError;
      console.log = originalLog;
    }
    expect(errors.join('\n')).toContain(message);
    expect(logs).toEqual([]);
  });
});

describe('describeStatus', () => {
  const viewer = {
    paneId: 'p1',
    url: 'https://example.com/',
    loading: false,
    designMode: false,
  };

  test('reports no viewer without telling the agent to open one', () => {
    expect(describeStatus([])).toEqual({
      viewer: false,
      viewers: [],
      next: 'No viewer is open in this terminal window.',
    });
  });

  test('tells the agent to reuse the one viewer in this window', () => {
    expect(describeStatus([viewer]).next).toContain('awrit tool text');
  });

  test('reports loading, review and ambiguous states instead of guessing', () => {
    expect(describeStatus([{ ...viewer, loading: true }]).next).toContain('awrit tool wait');
    expect(describeStatus([{ ...viewer, designMode: true }]).next).toContain(
      'Wait for their feedback',
    );
    expect(describeStatus([viewer, { ...viewer, paneId: 'p2' }]).next).toContain('--pane ID');
  });
});

describe('remote panes', () => {
  function runtimeDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-runtime-'));
  }

  async function remotePane(
    windowId: string,
    forward: Parameters<typeof startRemotePane>[0]['forward'],
  ) {
    const runtime = runtimeDir();
    setEnv('XDG_RUNTIME_DIR', runtime);
    setEnv('AWRIT_IPC_SOCKET', path.join(runtime, 'none.sock'));
    setEnv('KITTY_WINDOW_ID', windowId);
    const pane = await startRemotePane({
      session: 's1',
      host: 'laptop',
      sourceWindowId: windowId,
      forward,
    });
    return {
      pane,
      cleanup() {
        pane.stop();
        fs.rmSync(runtime, { recursive: true, force: true });
      },
    };
  }

  test('routes a tool call to this window remote pane when no local owner runs', async () => {
    const calls: unknown[] = [];
    const remote = await remotePane('7', async (type, payload) => {
      calls.push({ type, payload });
      return { ok: true, items: [] };
    });
    const logs: string[] = [];
    const original = console.log;
    console.log = (line: unknown) => logs.push(String(line));
    try {
      expect(await runToolCommand(['snapshot'])).toBe(0);
    } finally {
      console.log = original;
      remote.cleanup();
    }
    expect(calls).toEqual([{ type: 'tool:call', payload: { name: 'snapshot', arguments: {} } }]);
    expect(logs.join('\n')).toContain('ok');
  });

  test('a local viewer wins over a remote pane for the same window', async () => {
    const socketPath = await serverWith(() => ({ ok: true, source: 'local' }));
    const calls: unknown[] = [];
    const remote = await remotePane('7', async (type, payload) => {
      calls.push({ type, payload });
      return { ok: true, source: 'remote' };
    });
    setEnv('AWRIT_IPC_SOCKET', socketPath);
    const original = console.log;
    console.log = () => {};
    try {
      expect(await runToolCommand(['text'])).toBe(0);
    } finally {
      console.log = original;
      remote.cleanup();
    }
    expect(calls).toEqual([]);
  });

  test('keeps the existing no-viewer error when nothing can serve this window', async () => {
    const runtime = runtimeDir();
    setEnv('XDG_RUNTIME_DIR', runtime);
    setEnv('AWRIT_IPC_SOCKET', path.join(runtime, 'none.sock'));
    setEnv('KITTY_WINDOW_ID', '7');
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => errors.push(String(line));
    try {
      expect(await runToolCommand(['text'])).toBe(1);
    } finally {
      console.error = original;
      fs.rmSync(runtime, { recursive: true, force: true });
    }
    expect(errors).toEqual([
      'No running Awrit viewer. Open a page first, for example: awrit show <url>',
    ]);
  });

  test('readStatus merges the remote viewer into this window viewers', async () => {
    const remote = await remotePane('7', async () => ({
      url: 'https://remote.example/',
      loading: false,
    }));
    try {
      const status = await readStatus('7');
      expect(status.viewer).toBe(true);
      expect(status.viewers).toEqual([
        { paneId: 's1', url: 'https://remote.example/', loading: false, designMode: false },
      ]);
    } finally {
      remote.cleanup();
    }
  });
});
