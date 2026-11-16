import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { findRemotePane, readRemotePanes, startRemotePane } from './registry';

const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-remote-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Same newline JSON the local owner socket speaks. */
function ask(socketPath: string, message: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = net.connect(socketPath);
    let buffered = '';
    client.on('connect', () => client.write(`${JSON.stringify(message)}\n`));
    client.on('error', reject);
    client.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const [line] = buffered.split('\n');
      if (!line) return;
      client.destroy();
      resolve(JSON.parse(line) as Record<string, unknown>);
    });
  });
}

describe('remote pane registry', () => {
  test('publishes a private entry and finds it by window or session', async () => {
    const dir = path.join(tempDir(), 'remote');
    const pane = await startRemotePane({
      dir,
      session: 's1',
      host: 'laptop',
      sourceWindowId: '7',
      forward: async () => ({}),
    });
    const entryPath = pane.socketPath.replace(/\.sock$/, '.json');

    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(entryPath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(pane.socketPath).mode & 0o777).toBe(0o600);
    expect(readRemotePanes(dir)).toEqual([
      {
        session: 's1',
        host: 'laptop',
        socket: pane.socketPath,
        sourceWindowId: '7',
        pid: process.pid,
      },
    ]);
    expect(findRemotePane({ windowId: '7' }, dir)?.session).toBe('s1');
    expect(findRemotePane({ paneId: 's1' }, dir)?.session).toBe('s1');
    expect(findRemotePane({ windowId: '8' }, dir)).toBeUndefined();

    pane.stop();
    expect(readRemotePanes(dir)).toEqual([]);
    expect(fs.existsSync(entryPath)).toBe(false);
    expect(fs.existsSync(pane.socketPath)).toBe(false);
  });

  test('refuses registry permission drift and symlinked directories without modifying them', async () => {
    const dir = path.join(tempDir(), 'remote');
    const pane = await startRemotePane({
      dir,
      session: 'private',
      host: 'host',
      forward: async () => ({}),
    });
    try {
      expect(readRemotePanes(dir)).toHaveLength(1);
      fs.chmodSync(dir, 0o777);
      expect(readRemotePanes(dir)).toEqual([]);
      expect(findRemotePane({ paneId: 'private' }, dir)).toBeUndefined();
      expect(fs.statSync(dir).mode & 0o777).toBe(0o777);
      fs.chmodSync(dir, 0o700);
      const link = path.join(tempDir(), 'link');
      fs.symlinkSync(dir, link);
      expect(readRemotePanes(link)).toEqual([]);
      expect(readRemotePanes(dir)).toHaveLength(1);
    } finally {
      fs.chmodSync(dir, 0o700);
      pane.stop();
    }
  });

  test('the same host session cannot unlink another local viewer', async () => {
    const dir = tempDir();
    const first = await startRemotePane({
      dir,
      session: 'same',
      host: 'first',
      forward: async () => ({ host: 'first' }),
    });
    const second = await startRemotePane({
      dir,
      session: 'same',
      host: 'second',
      forward: async () => ({ host: 'second' }),
    });
    try {
      expect(second.socketPath).not.toBe(first.socketPath);
      expect(readRemotePanes(dir)).toHaveLength(2);
      expect(findRemotePane({ paneId: 'same' }, dir)).toBeUndefined();
      second.stop();
      expect(findRemotePane({ paneId: 'same' }, dir)?.host).toBe('first');
      expect(
        (await ask(first.socketPath, { type: 'tools:list', requestId: 'alive' })).data,
      ).toEqual({ host: 'first' });
      expect(readRemotePanes(dir)).toHaveLength(1);
    } finally {
      first.stop();
      second.stop();
    }
  });

  test('ignores an entry whose process is gone', () => {
    const dir = tempDir();
    fs.writeFileSync(
      path.join(dir, 'dead.json'),
      JSON.stringify({
        session: 'dead',
        host: 'laptop',
        socket: path.join(dir, 'dead.sock'),
        sourceWindowId: '7',
        pid: 999_999,
      }),
    );
    fs.writeFileSync(path.join(dir, 'junk.json'), 'not json');
    expect(readRemotePanes(dir)).toEqual([]);
  });

  test('forwards tool:call and viewer:status to the attached viewer', async () => {
    const dir = tempDir();
    const calls: unknown[] = [];
    const pane = await startRemotePane({
      dir,
      session: 's1',
      host: 'laptop',
      sourceWindowId: '7',
      forward: async (type, payload) => {
        calls.push({ type, payload });
        if (type === 'viewer:status') return { url: 'https://example.com/', loading: true };
        return { ok: true, text: 'hi' };
      },
    });

    expect(
      await ask(pane.socketPath, {
        type: 'tool:call',
        requestId: 'a1',
        name: 'text',
        arguments: { max: 10 },
      }),
    ).toEqual({
      type: 'tool:call:response',
      requestId: 'a1',
      ok: true,
      data: { ok: true, text: 'hi' },
    });
    expect(calls).toEqual([
      { type: 'tool:call', payload: { name: 'text', arguments: { max: 10 } } },
    ]);

    expect(
      await ask(pane.socketPath, { type: 'viewer:status', requestId: 'a2', sourceWindowId: '7' }),
    ).toEqual({
      type: 'viewer:status:response',
      requestId: 'a2',
      ok: true,
      data: {
        viewers: [{ paneId: 's1', url: 'https://example.com/', loading: true, designMode: false }],
      },
    });
    expect(await ask(pane.socketPath, { type: 'tools:list', requestId: 'a3' })).toEqual({
      type: 'tools:list:response',
      requestId: 'a3',
      ok: true,
      data: { ok: true, text: 'hi' },
    });
    // The local window id is never forwarded to the remote side.
    expect(JSON.stringify(calls)).not.toContain('sourceWindowId');
    pane.stop();
  });

  test('forwards a capture request with its wait options', async () => {
    const dir = tempDir();
    const calls: unknown[] = [];
    const pane = await startRemotePane({
      dir,
      session: 's1',
      host: 'laptop',
      forward: async (type, payload) => {
        calls.push({ type, payload });
        return { base64: 'cG5n', url: 'https://example.com/', inputWidth: 640, inputHeight: 480 };
      },
    });

    expect(
      await ask(pane.socketPath, {
        type: 'capture:request',
        requestId: 'c1',
        waitMs: 250,
        waitSelector: '#ready',
      }),
    ).toEqual({
      type: 'capture:request:response',
      requestId: 'c1',
      ok: true,
      data: { base64: 'cG5n', url: 'https://example.com/', inputWidth: 640, inputHeight: 480 },
    });
    expect(calls).toEqual([
      { type: 'capture:request', payload: { waitMs: 250, waitSelector: '#ready' } },
    ]);

    expect(
      await ask(pane.socketPath, { type: 'capture:request', requestId: 'c2', waitMs: 'soon' }),
    ).toEqual({
      type: 'capture:request:response',
      requestId: 'c2',
      ok: false,
      error: 'Invalid capture options',
    });
    expect(calls).toHaveLength(1);
    pane.stop();
  });

  test('a failing forward becomes an ok:false reply, not a dropped connection', async () => {
    const dir = tempDir();
    const pane = await startRemotePane({
      dir,
      session: 's1',
      host: 'laptop',
      forward: async () => {
        throw new Error('Remote session is not attached');
      },
    });
    expect(
      await ask(pane.socketPath, {
        type: 'tool:call',
        requestId: 'a1',
        name: 'text',
        arguments: {},
      }),
    ).toEqual({
      type: 'tool:call:response',
      requestId: 'a1',
      ok: false,
      error: 'Remote session is not attached',
    });
    pane.stop();
  });
});
