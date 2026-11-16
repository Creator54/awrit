import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import fs, {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSupervisor, supervisorDir, supervisorSocketPath } from './supervisor';

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-supervisor-'));
  chmodSync(dir, 0o700);
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function deps(dir: string, onConnection: (socket: net.Socket) => void = (socket) => socket.end()) {
  const state = { ownerStarts: 0, ownerStops: 0 };
  return {
    state,
    deps: {
      dir,
      startOwner: async () => {
        state.ownerStarts += 1;
      },
      stopOwner: async () => {
        state.ownerStops += 1;
      },
      onConnection,
    },
  };
}

describe('startSupervisor', () => {
  test('bounds open lanes and admits a replacement after close', async () => {
    let accepted = 0;
    let firstServer: net.Socket | undefined;
    const supervisor = await startSupervisor(
      deps(tempDir(), (socket) => {
        accepted++;
        firstServer ??= socket;
        socket.write('ready');
      }).deps,
    );
    cleanups.push(() => supervisor.stop());
    const clients: net.Socket[] = [];
    cleanups.push(() => {
      for (const client of clients) client.destroy();
    });
    async function connect(): Promise<net.Socket> {
      const client = net.connect(supervisor.socketPath);
      clients.push(client);
      await new Promise<void>((resolve, reject) => {
        client.once('data', () => resolve());
        client.once('error', reject);
      });
      return client;
    }
    for (let index = 0; index < 128; index++) await connect();
    const excess = net.connect(supervisor.socketPath);
    clients.push(excess);
    excess.on('error', () => {});
    await new Promise<void>((resolve) => excess.once('close', () => resolve()));
    expect(accepted).toBe(128);
    const first = clients[0];
    if (!first || !firstServer) throw new Error('Missing first lane');
    const released = new Promise<void>((resolve) => firstServer.once('close', () => resolve()));
    first.end();
    await released;
    await connect();
    expect(accepted).toBe(129);
  });

  test('refuses a group or world accessible directory', async () => {
    const dir = tempDir();
    chmodSync(dir, 0o755);
    const { deps: options, state } = deps(dir);
    await expect(startSupervisor(options)).rejects.toThrow(/0700|private/);
    expect(state.ownerStarts).toBe(0);
  });

  test('refuses a symlinked directory', async () => {
    const dir = tempDir();
    const link = path.join(tempDir(), 'linked');
    symlinkSync(dir, link);
    const { deps: options, state } = deps(link);
    await expect(startSupervisor(options)).rejects.toThrow(/symlink/);
    expect(state.ownerStarts).toBe(0);
  });

  test('holds an exclusive lock until it stops', async () => {
    const dir = tempDir();
    const first = await startSupervisor(deps(dir).deps);
    cleanups.push(() => first.stop());
    const lockPath = path.join(dir, 'supervisor.lock');
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    await expect(startSupervisor(deps(dir).deps)).rejects.toThrow(/already running/);
    await first.stop();
    const second = await startSupervisor(deps(dir).deps);
    cleanups.push(() => second.stop());
  });

  test('takes over a stale lock', async () => {
    const dir = tempDir();
    const lockPath = path.join(dir, 'supervisor.lock');
    // A pid above any real pid_max is reliably gone (process.kill raises ESRCH).
    writeFileSync(lockPath, '999999999', { mode: 0o600 });
    const supervisor = await startSupervisor(deps(dir).deps);
    cleanups.push(() => supervisor.stop());
    expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
  });

  test('retries when a concurrent taker removes the lock mid-acquire', async () => {
    const dir = tempDir();
    const lockPath = path.join(dir, 'supervisor.lock');
    writeFileSync(lockPath, '999999999', { mode: 0o600 });
    const realOpen = fs.openSync;
    let injected = false;
    const spy = spyOn(fs, 'openSync').mockImplementation(((file, flags, mode) => {
      if (file === lockPath && flags === 'wx' && !injected) {
        injected = true;
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      }
      return realOpen(file, flags, mode);
    }) as typeof fs.openSync);
    try {
      const supervisor = await startSupervisor(deps(dir).deps);
      cleanups.push(() => supervisor.stop());
      expect(injected).toBe(true);
      expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    } finally {
      spy.mockRestore();
    }
  });

  test('does not take over a fresh lock that appears during stale takeover', async () => {
    const dir = tempDir();
    const lockPath = path.join(dir, 'supervisor.lock');
    writeFileSync(lockPath, '999999999', { mode: 0o600 });
    const realRead = fs.readFileSync;
    let injected = false;
    const spy = spyOn(fs, 'readFileSync').mockImplementation(((file, options) => {
      const result = realRead(file, options);
      if (file === lockPath && String(result) === '999999999' && !injected) {
        injected = true;
        writeFileSync(lockPath, String(process.pid), { mode: 0o600 });
      }
      return result;
    }) as typeof fs.readFileSync);
    try {
      await expect(startSupervisor(deps(dir).deps)).rejects.toThrow(/already running/);
      expect(injected).toBe(true);
      expect(readFileSync(lockPath, 'utf8')).toBe(String(process.pid));
    } finally {
      spy.mockRestore();
    }
  });

  test('stops a live connection and the owner it started', async () => {
    const dir = tempDir();
    const accepted = Promise.withResolvers<net.Socket>();
    const built = deps(dir, (socket) => accepted.resolve(socket));
    const supervisor = await startSupervisor(built.deps);
    const client = net.connect(supervisor.socketPath);
    cleanups.push(() => client.destroy());
    const serverSide = await accepted.promise;

    const stopped = Promise.race([
      supervisor.stop().then(() => true),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1_000);
        timer.unref?.();
      }),
    ]);
    expect(await stopped).toBe(true);
    expect(serverSide.destroyed).toBe(true);
    expect(built.state.ownerStops).toBe(1);
  });

  test('each owner build gets its own supervisor directory', () => {
    const env = { XDG_RUNTIME_DIR: '/run/user/7' };
    expect(supervisorDir('a'.repeat(64), env)).toBe(`/run/user/7/awrit-remote/${'a'.repeat(16)}`);
    expect(supervisorDir('b'.repeat(64), env)).not.toBe(supervisorDir('a'.repeat(64), env));
  });

  test('listens on a private socket and removes it on stop', async () => {
    const dir = tempDir();
    const received = Promise.withResolvers<net.Socket>();
    const options = deps(dir, (socket) => received.resolve(socket)).deps;
    const supervisor = await startSupervisor(options);
    cleanups.push(() => supervisor.stop());
    const socketPath = supervisorSocketPath(dir);
    expect(supervisor.socketPath).toBe(socketPath);
    expect(lstatSync(socketPath).mode & 0o777).toBe(0o600);

    const client = net.connect(socketPath);
    cleanups.push(() => client.destroy());
    const serverSide = await received.promise;
    expect(serverSide.destroyed).toBe(false);
    client.destroy();
    serverSide.destroy();

    await supervisor.stop();
    expect(existsSync(socketPath)).toBe(false);
    expect(existsSync(path.join(dir, 'supervisor.lock'))).toBe(false);
  });
});
