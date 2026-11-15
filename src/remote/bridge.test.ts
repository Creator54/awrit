import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  parseRemoteOwnerKind,
  remoteAndroidOwnerCommand,
  remoteAndroidOwnerEntry,
  remoteOwnerCommand,
  runBridge,
} from './bridge';

const cli = path.join(import.meta.dir, '../presentation/main.ts');

async function waitUntil(check: () => boolean, timeoutMs = 2_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the bridge');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function listen(socketPath: string, onSocket: (socket: net.Socket) => void) {
  const server = net.createServer(onSocket);
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return server;
}

function tempSocket(): { dir: string; socketPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-bridge-'));
  return {
    dir,
    socketPath: path.join(dir, 'supervisor.sock'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('runBridge', () => {
  test('round-trips bytes over a real unix socket', async () => {
    const { socketPath, cleanup } = tempSocket();
    const server = await listen(socketPath, (socket) => {
      socket.on('data', (chunk) => socket.write(chunk));
    });
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const received: number[] = [];
      stdout.on('data', (chunk: Buffer) => received.push(...chunk));
      const stderr = new PassThrough();
      const running = runBridge({ channel: 'media', socketPath, stdin, stdout, stderr });
      stdin.write(Buffer.from([0, 1, 2, 255]));
      await waitUntil(() => received.length === 4);
      expect(received).toEqual([0, 1, 2, 255]);
      stdin.end();
      expect(await running).toBe(0);
    } finally {
      server.close();
      cleanup();
    }
  });

  test('flushes queued stdin bytes before closing', async () => {
    const { socketPath, cleanup } = tempSocket();
    const payload = Buffer.alloc(8 * 1024 * 1024);
    for (let i = 0; i < payload.length; i += 1) payload[i] = i % 251;
    const received = Promise.withResolvers<Buffer>();
    const chunks: Buffer[] = [];
    let total = 0;
    let serverSide: net.Socket | undefined;
    const server = await listen(socketPath, (socket) => {
      serverSide = socket;
      socket.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        total += chunk.length;
        if (total >= payload.length) received.resolve(Buffer.concat(chunks));
      });
    });
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const running = runBridge({ channel: 'bulk', socketPath, stdin, stdout, stderr });
      stdin.write(payload);
      stdin.end();
      expect((await received.promise).equals(payload)).toBe(true);
      expect(await running).toBe(0);
    } finally {
      serverSide?.destroy();
      server.close();
      cleanup();
    }
  });

  test('exits when the local side closes', async () => {
    const { socketPath, cleanup } = tempSocket();
    const closed = Promise.withResolvers<void>();
    const server = await listen(socketPath, (socket) => {
      socket.on('close', () => closed.resolve());
    });
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const running = runBridge({ channel: 'control', socketPath, stdin, stdout, stderr });
      stdin.end();
      expect(await running).toBe(0);
      await closed.promise;
    } finally {
      server.close();
      cleanup();
    }
  });

  test('exits when the remote side closes', async () => {
    const { socketPath, cleanup } = tempSocket();
    const server = await listen(socketPath, (socket) => socket.end());
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const running = runBridge({ channel: 'bulk', socketPath, stdin, stdout, stderr });
      expect(await running).toBe(0);
      // A still-flowing stdin would keep the bridge process, and its SSH lane, alive.
      expect(stdin.isPaused()).toBe(true);
    } finally {
      server.close();
      cleanup();
    }
  });

  test('reports a clear error and exits nonzero when no socket accepts', async () => {
    const { dir, cleanup } = tempSocket();
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      let message = '';
      stderr.on('data', (chunk: Buffer) => {
        message += chunk.toString();
      });
      const code = await runBridge({
        channel: 'control',
        socketPath: path.join(dir, 'missing.sock'),
        stdin,
        stdout,
        stderr,
      });
      expect(code).toBe(1);
      expect(message).toContain('supervisor');
    } finally {
      cleanup();
    }
  });

  test('rejects an unknown channel before connecting', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let message = '';
    stderr.on('data', (chunk: Buffer) => {
      message += chunk.toString();
    });
    const code = await runBridge({
      channel: 'shell',
      socketPath: '/nonexistent',
      stdin,
      stdout,
      stderr,
      connect: () => {
        throw new Error('must not connect');
      },
    });
    expect(code).toBe(2);
    expect(message).toContain('channel');
  });

  test('starts the owner once when the socket is unreachable, then connects', async () => {
    const { socketPath, cleanup } = tempSocket();
    let launches = 0;
    let server: net.Server | undefined;
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const received: number[] = [];
      stdout.on('data', (chunk: Buffer) => received.push(...chunk));
      const running = runBridge({
        channel: 'control',
        socketPath,
        stdin,
        stdout,
        stderr: new PassThrough(),
        ownerRetry: { timeoutMs: 2_000, intervalMs: 10 },
        launchOwner: () => {
          launches += 1;
          server = net.createServer((socket) => socket.on('data', (chunk) => socket.write(chunk)));
          server.listen(socketPath);
        },
      });
      stdin.write(Buffer.from([1, 2, 3]));
      await waitUntil(() => received.length === 3);
      expect(launches).toBe(1);
      stdin.end();
      expect(await running).toBe(0);
    } finally {
      server?.close();
      cleanup();
    }
  });
});

async function runCli(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

describe('remoteOwnerCommand', () => {
  test('runs the packaged owner beside the CLI with headless ozone after the entry', () => {
    expect(
      remoteOwnerCommand(
        { AWRIT_ELECTRON: '/e/electron' },
        '/pkg/lib/awrit/dist/presentation-cli.js',
      ),
    ).toEqual({
      electron: '/e/electron',
      args: [
        '/pkg/lib/awrit/dist/browserOwner/main.js',
        '--remote-owner',
        '--ozone-platform=headless',
        '--debug-port=disabled',
      ],
    });
  });

  test('requires AWRIT_ELECTRON', () => {
    expect(() => remoteOwnerCommand({}, '/pkg/dist/presentation-cli.js')).toThrow('AWRIT_ELECTRON');
  });
});

describe('remoteAndroidOwnerCommand', () => {
  test('runs the headless Node owner beside the CLI, without Electron', () => {
    expect(remoteAndroidOwnerCommand({}, '/pkg/lib/awrit/dist/presentation-cli.js')).toEqual({
      node: process.execPath,
      args: ['/pkg/lib/awrit/dist/remote/androidOwner.js', '--remote-android-owner'],
    });
  });

  test('entry can be overridden, matching the browser owner variable', () => {
    const env = { AWRIT_ANDROID_OWNER_ENTRY: '/custom/androidOwner.js' };
    expect(remoteAndroidOwnerEntry(env, '/pkg/dist/presentation-cli.js')).toBe(
      '/custom/androidOwner.js',
    );
    expect(remoteAndroidOwnerCommand(env, '/pkg/dist/presentation-cli.js').args).toEqual([
      '/custom/androidOwner.js',
      '--remote-android-owner',
    ]);
  });
});

describe('parseRemoteOwnerKind', () => {
  test('defaults to browser and accepts android', () => {
    expect(parseRemoteOwnerKind('browser')).toBe('browser');
    expect(parseRemoteOwnerKind('android')).toBe('android');
  });

  test('rejects anything else', () => {
    for (const value of ['', 'Android', 'electron', 'remote-android-owner'])
      expect(() => parseRemoteOwnerKind(value)).toThrow('owner kind');
  });
});

describe('runBridge owner kind', () => {
  test('android kind connects once its owner is launched', async () => {
    const { socketPath, cleanup } = tempSocket();
    let server: net.Server | undefined;
    try {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const received: number[] = [];
      stdout.on('data', (chunk: Buffer) => received.push(...chunk));
      const running = runBridge({
        kind: 'android',
        channel: 'control',
        socketPath,
        stdin,
        stdout,
        stderr: new PassThrough(),
        ownerRetry: { timeoutMs: 2_000, intervalMs: 10 },
        launchOwner: () => {
          server = net.createServer((socket) => socket.on('data', (chunk) => socket.write(chunk)));
          server.listen(socketPath);
        },
      });
      stdin.write(Buffer.from([4, 5, 6]));
      await waitUntil(() => received.length === 3);
      stdin.end();
      expect(await running).toBe(0);
    } finally {
      server?.close();
      cleanup();
    }
  });

  test('rejects an unknown kind before connecting', async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let message = '';
    stderr.on('data', (chunk: Buffer) => {
      message += chunk.toString();
    });
    const code = await runBridge({
      kind: 'remote-android-owner',
      channel: 'control',
      socketPath: '/nonexistent',
      stdin,
      stdout,
      stderr,
      connect: () => {
        throw new Error('must not connect');
      },
    });
    expect(code).toBe(2);
    expect(message).toContain('owner kind');
  });
});

describe('remote-bridge dispatch', () => {
  test('help output does not show the hidden subcommand', async () => {
    const show = await runCli(['show', '--help']);
    expect(show.code).toBe(0);
    expect(show.stdout).toStartWith('Usage: awrit show');
    expect(show.stdout).not.toContain('remote-bridge');
    const top = await runCli(['--help']);
    expect(top.stdout).not.toContain('remote-bridge');
  });

  test('rejects a missing or unknown channel', async () => {
    for (const args of [['remote-bridge'], ['remote-bridge', '--channel', 'nope']]) {
      const result = await runCli(args);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain('channel');
    }
  });
});
