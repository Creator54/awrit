import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { RemoteChannel } from './sshCommand';

const CHANNELS: readonly RemoteChannel[] = ['control', 'media', 'bulk'];

export function parseRemoteChannel(value: string): RemoteChannel {
  for (const channel of CHANNELS) if (channel === value) return channel;
  throw new Error(`Unknown channel ${JSON.stringify(value)}; expected control, media or bulk`);
}

const OWNER_KINDS: readonly RemoteOwnerKind[] = ['browser', 'android'];

/** `browser` is the Electron owner; `android` is the headless Node Android owner. */
export type RemoteOwnerKind = 'browser' | 'android';

export function parseRemoteOwnerKind(value: string): RemoteOwnerKind {
  for (const kind of OWNER_KINDS) if (kind === value) return kind;
  throw new Error(`Unknown owner kind ${JSON.stringify(value)}; expected browser or android`);
}

export interface BridgeOptions {
  channel: string;
  /** Which remote owner this bridge reaches; defaults to the Electron browser owner. */
  kind?: string;
  socketPath: string;
  stdin: Readable;
  stdout: Writable;
  stderr?: Writable;
  connect?: (socketPath: string) => net.Socket;
  /** Starts the remote owner when the socket is unreachable; injected in tests. */
  launchOwner?: () => void;
  ownerRetry?: { timeoutMs?: number; intervalMs?: number };
}

const defaultConnect = (socketPath: string) => net.connect(socketPath);

/** The owner entry; its hash names the supervisor this bridge and that owner share. */
export function remoteOwnerEntry(env: NodeJS.ProcessEnv, cliPath: string): string {
  return env.AWRIT_OWNER_ENTRY ?? path.resolve(path.dirname(cliPath), 'browserOwner/main.js');
}

/** Electron argv for the remote owner. The bridge runs from dist/presentation-cli.js, beside dist/browserOwner/. */
export function remoteOwnerCommand(
  env: NodeJS.ProcessEnv,
  cliPath: string,
): { electron: string; args: string[] } {
  const electron = env.AWRIT_ELECTRON;
  if (!electron) throw new Error('AWRIT_ELECTRON is required to start the Awrit remote owner');
  const entry = remoteOwnerEntry(env, cliPath);
  // Ozone picks its platform before app code runs, so the switch must be on the command line,
  // after the entry: the owner reads its build identity from argv[1].
  // No DevTools port: remote panes are driven over the SSH lanes only, and an
  // open port would let any local process on the host control the pages.
  return {
    electron,
    args: [entry, '--remote-owner', '--ozone-platform=headless', '--debug-port=disabled'],
  };
}

/** The headless Node Android owner entry; it never starts Electron. */
export function remoteAndroidOwnerEntry(env: NodeJS.ProcessEnv, cliPath: string): string {
  return (
    env.AWRIT_ANDROID_OWNER_ENTRY ?? path.resolve(path.dirname(cliPath), 'remote/androidOwner.js')
  );
}

/** Node argv for the remote Android owner. The bridge runs from dist/presentation-cli.js. */
export function remoteAndroidOwnerCommand(
  env: NodeJS.ProcessEnv,
  cliPath: string,
): { node: string; args: string[] } {
  return {
    node: process.execPath,
    args: [remoteAndroidOwnerEntry(env, cliPath), '--remote-android-owner'],
  };
}

function ownerCommand(kind: RemoteOwnerKind): { file: string; args: string[] } {
  if (kind === 'android') {
    const { node, args } = remoteAndroidOwnerCommand(process.env, process.argv[1]);
    return { file: node, args };
  }
  const { electron, args } = remoteOwnerCommand(process.env, process.argv[1]);
  return { file: electron, args };
}

function startRemoteOwner(kind: RemoteOwnerKind, socketPath: string): void {
  const { file, args } = ownerCommand(kind);
  const dir = path.dirname(socketPath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(path.join(dir, 'owner.log'), 'a', 0o600);
  try {
    const child = spawn(file, args, {
      detached: true,
      stdio: ['ignore', fd, fd],
    });
    // A failed spawn surfaces as a bounded connect timeout, like a crashed owner.
    child.on('error', () => {});
    child.unref();
  } finally {
    fs.closeSync(fd);
  }
}

async function connectWithRetry(
  socketPath: string,
  connect: (path: string) => net.Socket,
  retry: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<net.Socket> {
  // A cold headless Electron start on a small ARM host takes several seconds.
  const timeoutMs = retry.timeoutMs ?? 20_000;
  const intervalMs = retry.intervalMs ?? 40;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await connectSocket(socketPath, connect);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

async function connectSocket(
  socketPath: string,
  connect: (path: string) => net.Socket,
): Promise<net.Socket> {
  const socket = connect(socketPath);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', () => resolve());
      socket.once('error', reject);
    });
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

/**
 * Pipes one SSH channel's stdio to the supervisor socket, byte for byte, and
 * exits when either side closes. Backpressure comes from the streams
 * themselves; nothing is buffered here.
 */
export async function runBridge(options: BridgeOptions): Promise<number> {
  const stderr = options.stderr ?? process.stderr;
  let channel: RemoteChannel;
  let kind: RemoteOwnerKind;
  try {
    channel = parseRemoteChannel(options.channel);
    kind = parseRemoteOwnerKind(options.kind ?? 'browser');
  } catch (error) {
    stderr.write(
      `awrit remote-bridge: ${error instanceof Error ? error.message : 'bad channel'}\n`,
    );
    return 2;
  }
  const connect = options.connect ?? defaultConnect;
  let socket: net.Socket;
  try {
    socket = await connectSocket(options.socketPath, connect);
  } catch (firstError) {
    const ownerManaged =
      options.launchOwner !== undefined || kind === 'android' || process.env.AWRIT_ELECTRON;
    if (channel === 'bulk' || !ownerManaged) {
      const reason = firstError instanceof Error ? firstError.message : String(firstError);
      stderr.write(
        `awrit remote-bridge: cannot reach the Awrit remote supervisor at ${options.socketPath} (${channel} channel): ${reason}\n`,
      );
      return 1;
    }
    try {
      (options.launchOwner ?? (() => startRemoteOwner(kind, options.socketPath)))();
      socket = await connectWithRetry(options.socketPath, connect, options.ownerRetry);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      stderr.write(
        `awrit remote-bridge: cannot reach the Awrit remote supervisor at ${options.socketPath} (${channel} channel): ${reason}\n`,
      );
      return 1;
    }
  }

  return new Promise<number>((resolve) => {
    let finished = false;
    const finish = (code: number) => {
      if (finished) return;
      finished = true;
      options.stdin.off('data', onStdinData);
      options.stdin.off('end', onStdinEnd);
      options.stdin.off('error', onStdinError);
      options.stdout.off('drain', onStdoutDrain);
      socket.off('data', onSocketData);
      socket.off('drain', onSocketDrain);
      socket.off('close', onSocketClose);
      socket.off('finish', onSocketFinish);
      socket.off('error', onSocketError);
      socket.destroy();
      // A flowing stdin keeps the process (and so the SSH channel) alive after
      // the owner closes; the client waits for that close to end a transfer.
      options.stdin.pause();
      resolve(code);
    };
    const onStdinData = (chunk: Buffer) => {
      if (!socket.write(chunk)) options.stdin.pause();
    };
    // Half-close so bytes already queued in the socket are flushed first.
    const onStdinEnd = () => {
      options.stdin.off('data', onStdinData);
      socket.end();
    };
    const onStdinError = () => finish(1);
    const onSocketDrain = () => options.stdin.resume();
    const onSocketData = (chunk: Buffer) => {
      if (!options.stdout.write(chunk)) socket.pause();
    };
    const onStdoutDrain = () => socket.resume();
    const onSocketFinish = () => finish(0);
    const onSocketClose = () => finish(0);
    const onSocketError = (error: Error) => {
      stderr.write(`awrit remote-bridge: channel failed: ${error.message}\n`);
      finish(1);
    };
    options.stdin.on('data', onStdinData);
    options.stdin.on('end', onStdinEnd);
    options.stdin.on('error', onStdinError);
    options.stdout.on('drain', onStdoutDrain);
    socket.on('data', onSocketData);
    socket.on('drain', onSocketDrain);
    socket.on('close', onSocketClose);
    socket.on('finish', onSocketFinish);
    socket.on('error', onSocketError);
  });
}
