import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { getAppDataPath } from '../paths';

export interface SupervisorDeps {
  /** Private directory override; tests pass a temp dir. */
  dir: string;
  /** Starts the browser owner. Injected so tests never start Electron. */
  startOwner: () => Promise<void>;
  /** Stops the owner started above; only called for an owner this supervisor started. */
  stopOwner: () => Promise<void>;
  /** Handles one accepted bridge connection. */
  onConnection: (socket: net.Socket) => void;
}

export interface Supervisor {
  readonly dir: string;
  readonly socketPath: string;
  stop(): Promise<void>;
}

const LOCK_NAME = 'supervisor.lock';
const SOCKET_NAME = 'supervisor.sock';

/**
 * $XDG_RUNTIME_DIR/awrit-remote/<build>, else <app data>/remote/<build>. One
 * supervisor per owner build, so a new runtime never attaches to an older
 * owner that is still serving sessions.
 */
export function supervisorDir(build: string, env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_RUNTIME_DIR
    ? path.join(env.XDG_RUNTIME_DIR, 'awrit-remote')
    : path.join(getAppDataPath(), 'remote');
  return path.join(base, build.slice(0, 16));
}

export function supervisorSocketPath(dir: string): string {
  return path.join(dir, SOCKET_NAME);
}

function errno(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** Creates or validates the directory; refuses anything another user can reach. */
export function ensurePrivateDir(dir: string): void {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(`Cannot create the Awrit remote directory ${dir}: ${String(error)}`);
  }
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink()) throw new Error(`Awrit remote directory ${dir} is a symlink`);
  if (!stat.isDirectory()) throw new Error(`Awrit remote directory ${dir} is not a directory`);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid)
    throw new Error(`Awrit remote directory ${dir} is not owned by uid ${uid}`);
  if ((stat.mode & 0o077) !== 0)
    throw new Error(`Awrit remote directory ${dir} must be private (0700)`);
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // ESRCH is the only answer that proves the pid is gone; EPERM still means alive.
    return !errno(error, 'ESRCH');
  }
}

function lockPid(lockPath: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(lockPath, 'utf8').trim();
  } catch (error) {
    if (errno(error, 'ENOENT')) return undefined;
    throw error;
  }
  return /^\d{1,10}$/.test(raw) ? Number(raw) : undefined;
}

/** Exclusive create holding our pid; a dead holder's lock is taken over. */
function acquireLock(dir: string): { path: string; release: () => void } {
  const lockPath = path.join(dir, LOCK_NAME);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        fs.writeSync(fd, String(process.pid));
      } finally {
        fs.closeSync(fd);
      }
      return {
        path: lockPath,
        release: () => {
          try {
            fs.unlinkSync(lockPath);
          } catch {}
        },
      };
    } catch (error) {
      // A concurrent taker may have removed the lock just before our exclusive open.
      if (errno(error, 'ENOENT')) continue;
      if (!errno(error, 'EEXIST')) throw error;
      const pid = lockPid(lockPath);
      if (pid !== undefined && pidAlive(pid))
        throw new Error(`Awrit remote supervisor is already running (pid ${pid})`);
      // Move the stale lock aside atomically; another process may have replaced it
      // between the read above and this rename.
      const aside = `${lockPath}.${process.pid}.${attempt}`;
      try {
        fs.renameSync(lockPath, aside);
      } catch (renameError) {
        if (errno(renameError, 'ENOENT')) continue;
        throw renameError;
      }
      const movedPid = lockPid(aside);
      if (movedPid !== undefined && movedPid !== pid && pidAlive(movedPid)) {
        // We raced a fresh owner; put its lock back and let the retry report it.
        try {
          fs.linkSync(aside, lockPath);
        } catch (linkError) {
          if (!errno(linkError, 'EEXIST')) throw linkError;
        }
        try {
          fs.unlinkSync(aside);
        } catch (unlinkError) {
          if (!errno(unlinkError, 'ENOENT')) throw unlinkError;
        }
        continue;
      }
      try {
        fs.unlinkSync(aside);
      } catch (unlinkError) {
        if (!errno(unlinkError, 'ENOENT')) throw unlinkError;
      }
    }
  }
  throw new Error(`Cannot acquire ${lockPath}`);
}

export function listenPrivate(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // A private umask covers the window before the chmod below lands.
    const umask = process.umask(0o077);
    const restore = () => process.umask(umask);
    server.once('error', (error) => {
      restore();
      reject(error);
    });
    server.listen(socketPath, () => {
      restore();
      try {
        fs.chmodSync(socketPath, 0o600);
        resolve();
      } catch (error) {
        reject(error);
      }
    });
  });
}

/**
 * Owns the per-user lock, socket and owner process. Resolves only once the
 * socket is listening.
 */
export async function startSupervisor(deps: SupervisorDeps): Promise<Supervisor> {
  const dir = deps.dir;
  ensurePrivateDir(dir);
  const lock = acquireLock(dir);
  const socketPath = supervisorSocketPath(dir);
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    // Bound decoder/socket memory across control, media and transient bulk lanes.
    if (sockets.size >= 128) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    deps.onConnection(socket);
  });
  let ownerStarted = false;
  try {
    await deps.startOwner();
    ownerStarted = true;
    try {
      fs.unlinkSync(socketPath);
    } catch (error) {
      if (!errno(error, 'ENOENT')) throw error;
    }
    await listenPrivate(server, socketPath);
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    if (server.listening) server.close();
    if (ownerStarted) await deps.stopOwner().catch(() => {});
    lock.release();
    throw error;
  }

  let stopping = false;
  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    let failure: unknown;
    try {
      await deps.stopOwner();
    } catch (error) {
      failure = error;
    }
    try {
      fs.unlinkSync(socketPath);
    } catch (error) {
      if (!errno(error, 'ENOENT') && failure === undefined) failure = error;
    }
    lock.release();
    if (failure !== undefined) throw failure;
  }

  return { dir, socketPath, stop };
}
