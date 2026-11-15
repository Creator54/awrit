import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { MAX_LINE_BYTES } from '../ipc/socketServer';
import { getAppDataPath } from '../paths';
import { ensurePrivateDir, listenPrivate } from './supervisor';

/**
 * Local side of a remote pane: while `awrit show --host` is attached it publishes
 * one private entry file per local viewer and serves the same newline JSON requests
 * `awrit tool` already sends to the local owner socket. The entry points at that
 * socket and never leaves this machine; nothing here reaches the ssh lane.
 */
export interface RemotePaneEntry {
  session: string;
  host: string;
  socket: string;
  /** Kitty window id of the terminal that opened the viewer; local-only data. */
  sourceWindowId?: string;
  pid: number;
}

export type RemoteRequestType = 'tool:call' | 'tools:list' | 'viewer:status' | 'capture:request';

export interface RemotePaneStatus {
  url: string;
  loading: boolean;
}

export interface RemotePaneServerOptions {
  session: string;
  host: string;
  sourceWindowId?: string;
  dir?: string;
  forward: (type: RemoteRequestType, payload: Record<string, unknown>) => Promise<unknown>;
}

export interface RemotePaneServer {
  session: string;
  socketPath: string;
  stop(): void;
}

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Private per-user directory, chosen like `getSocketPath`. */
export function remotePaneDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_RUNTIME_DIR ? path.join(env.XDG_RUNTIME_DIR, 'awrit') : getAppDataPath();
  return path.join(base, 'remote');
}

function isEntry(value: unknown): value is RemotePaneEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.session === 'string' &&
    typeof entry.host === 'string' &&
    typeof entry.socket === 'string' &&
    (entry.sourceWindowId === undefined || typeof entry.sourceWindowId === 'string') &&
    typeof entry.pid === 'number' &&
    Number.isSafeInteger(entry.pid) &&
    entry.pid > 0
  );
}

function isLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Attached remote panes whose viewer process is still alive. */
export function readRemotePanes(dir = remotePaneDir()): RemotePaneEntry[] {
  let names: string[];
  try {
    // Readers must not trust a registry made writable by another uid. Do not
    // repair permissions here: discovery is read-only and fails closed.
    const stat = fs.lstatSync(dir);
    const uid = process.getuid?.();
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (uid !== undefined && stat.uid !== uid) ||
      (stat.mode & 0o077) !== 0
    )
      return [];
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const panes: RemotePaneEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      if (isEntry(value) && isLive(value.pid)) panes.push(value);
    } catch {
      // A half-written or foreign file is not a pane.
    }
  }
  return panes;
}

/** `--pane <session>` wins; otherwise the one viewer opened from this terminal window. */
export function findRemotePane(
  target: { windowId?: string; paneId?: string },
  dir = remotePaneDir(),
): RemotePaneEntry | undefined {
  const panes = readRemotePanes(dir);
  if (target.paneId) {
    const matches = panes.filter((pane) => pane.session === target.paneId);
    return matches.length === 1 ? matches[0] : undefined;
  }
  if (!target.windowId) return undefined;
  return panes.find((pane) => pane.sourceWindowId === target.windowId);
}

function reply(
  socket: net.Socket,
  type: RemoteRequestType,
  requestId: string,
  body: Record<string, unknown>,
): void {
  if (socket.destroyed || !socket.writable) return;
  socket.write(JSON.stringify({ type: `${type}:response`, requestId, ...body }) + '\n');
}

/** Wait options for a capture; bounded again at the owner. */
function capturePayload(message: object): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  const waitMs = Reflect.get(message, 'waitMs');
  if (waitMs !== undefined) {
    if (typeof waitMs !== 'number' || !Number.isFinite(waitMs))
      throw new Error('Invalid capture options');
    payload.waitMs = waitMs;
  }
  const waitSelector = Reflect.get(message, 'waitSelector');
  if (waitSelector !== undefined) {
    if (typeof waitSelector !== 'string') throw new Error('Invalid capture options');
    payload.waitSelector = waitSelector;
  }
  return payload;
}

/** Runs one client request; failures become the `ok: false` reply the CLI already reads. */
async function serve(
  socket: net.Socket,
  line: string,
  options: RemotePaneServerOptions,
): Promise<void> {
  if (!line.trim()) return;
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object') return;
  const type = Reflect.get(message, 'type');
  const requestId = Reflect.get(message, 'requestId');
  if (typeof requestId !== 'string') return;
  if (
    type !== 'tool:call' &&
    type !== 'tools:list' &&
    type !== 'viewer:status' &&
    type !== 'capture:request'
  )
    return;
  try {
    if (type === 'capture:request') {
      const data = await options.forward(type, capturePayload(message));
      reply(socket, type, requestId, { ok: true, data });
      return;
    }
    if (type === 'viewer:status') {
      const status = (await options.forward(type, {})) as RemotePaneStatus;
      reply(socket, type, requestId, {
        ok: true,
        data: { viewers: [{ paneId: options.session, ...status, designMode: false }] },
      });
      return;
    }
    if (type === 'tools:list') {
      reply(socket, type, requestId, { ok: true, data: await options.forward(type, {}) });
      return;
    }
    const name = Reflect.get(message, 'name');
    if (typeof name !== 'string' || !name.length) throw new Error('Invalid tool name');
    const input = Reflect.get(message, 'arguments') ?? {};
    const data = await options.forward(type, { name, arguments: input });
    reply(socket, type, requestId, { ok: true, data });
  } catch (error) {
    reply(socket, type, requestId, {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Publishes the entry and listens for `awrit tool` / `awrit status` while attached. */
export async function startRemotePane(options: RemotePaneServerOptions): Promise<RemotePaneServer> {
  if (!SESSION_ID.test(options.session)) throw new Error('Invalid remote session id');
  const dir = options.dir ?? remotePaneDir();
  ensurePrivateDir(dir);
  // The host chooses session ids, so they must not choose files we replace or unlink.
  const id = randomBytes(16).toString('hex');
  const socketPath = path.join(dir, `${id}.sock`);
  const entryPath = path.join(dir, `${id}.json`);
  const server = net.createServer((socket) => {
    let buffered = '';
    socket.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      if (buffered.length > MAX_LINE_BYTES) {
        buffered = '';
        socket.destroy();
        return;
      }
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) void serve(socket, line, options);
    });
    socket.on('error', () => socket.destroy());
  });
  await listenPrivate(server, socketPath);
  const entry: RemotePaneEntry = {
    session: options.session,
    host: options.host,
    socket: socketPath,
    ...(options.sourceWindowId ? { sourceWindowId: options.sourceWindowId } : {}),
    pid: process.pid,
  };
  fs.writeFileSync(entryPath, JSON.stringify(entry), { mode: 0o600 });
  fs.chmodSync(entryPath, 0o600);

  return {
    session: options.session,
    socketPath,
    stop() {
      server.close();
      fs.rmSync(socketPath, { force: true });
      fs.rmSync(entryPath, { force: true });
    },
  };
}
