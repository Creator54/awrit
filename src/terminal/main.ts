import { launchArgumentError } from '../args';
import { normalizePaneLaunch } from '../browserOwner/options';
import { ownerBuildIdentity } from '../browserOwner/build';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import {
  listenForInput,
  termEnableFeatures,
  termDisableFeatures,
  getWindowSize,
  type SupportedFeatures,
} from 'awrit-native-rs';
import { ownerSocketPath } from '../browserOwner/discovery';
import { FrameDecoder, encodeFrame } from '../browserOwner/protocol';
import { defaultOutput } from '../tty/output';
import { defaultGraphics } from '../tty/kittyGraphics';

// Dedicated testable entry; normal launcher is not switched until compatibility tests pass.
// Last lines this launch wrote to owner.log, so a startup failure (e.g. a Chromium sandbox
// error) is shown to the user instead of only a file path.
function logTail(file: string, from: number): string {
  try {
    const lines = fs.readFileSync(file).subarray(from).toString('utf8').trim().split('\n').slice(-5);
    return lines[0] ? `:\n${lines.join('\n')}` : '';
  } catch {
    return '';
  }
}

async function main() {
  const argumentError = launchArgumentError(process.argv.slice(2));
  if (argumentError) {
    console.error(argumentError);
    process.exitCode = 2;
    return;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    // An agent shell has no terminal: open the viewer beside the caller's own Kitty window,
    // not whichever window has focus.
    const launcher = process.env.AWRIT_LAUNCHER;
    if (launcher && process.env.KITTY_WINDOW_ID && process.env.KITTY_LISTEN_ON) {
      const { launchKitty } = await import('../presentation/kitty');
      const receipt = await launchKitty({
        sourceWindowId: process.env.KITTY_WINDOW_ID,
        mode: 'split',
        launchSpec: { binary: launcher, argv: process.argv.slice(2) },
      });
      process.stdout.write(`${JSON.stringify(receipt)}\n`);
      return;
    }
    console.error('Awrit browser panes require an interactive terminal.');
    process.exitCode = 1;
    return;
  }
  const launch = normalizePaneLaunch(
    process.argv.slice(2),
    process.env.AWRIT_CALLER_CWD ?? process.cwd(),
  );
  const socketPath = ownerSocketPath();
  const entry =
    process.env.AWRIT_OWNER_ENTRY ??
    path.resolve(path.dirname(process.argv[1]), '../browserOwner/main.js');
  const build = ownerBuildIdentity(entry);
  let socket: net.Socket | undefined;
  let features: SupportedFeatures | undefined;
  let stop: (() => void) | undefined;
  let closed = false;
  let terminalStarted = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    stop?.();
    if (features) {
      defaultGraphics.clearPlacements();
      termDisableFeatures(features);
    }
    if (terminalStarted) defaultOutput.cleanup();
    socket?.destroy();
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);
  try {
    const connect = () =>
      new Promise<net.Socket>((resolve, reject) => {
        const candidate = net.createConnection(socketPath);
        candidate.once('error', reject);
        candidate.once('connect', () => {
          candidate.removeListener('error', reject);
          resolve(candidate);
        });
      });
    try {
      socket = await connect();
    } catch {
      const electron = process.env.AWRIT_ELECTRON;
      if (!electron) throw new Error('AWRIT_ELECTRON is required for the terminal client');
      const fd = fs.openSync(path.join(path.dirname(socketPath), 'owner.log'), 'a', 0o600);
      const logStart = fs.fstatSync(fd).size;
      const child = spawn(electron, [entry, `--debug-port=${launch.debugPort}`, '--high-dpi-support=1'], {
        detached: true,
        stdio: ['ignore', fd, fd],
      });
      let spawnError: Error | undefined;
      let earlyExit: string | undefined;
      let childExitTime: number | undefined;
      child.once('exit', (code, signal) => {
        childExitTime = Date.now();
        // Code 1 is also the expected loser of the single-instance lock race.
        if (signal || (code !== null && code !== 0 && code !== 1)) {
          earlyExit = signal ? `signal ${signal}` : `code ${code}`;
        }
      });
      child.on('error', (error) => {
        spawnError = error;
      });
      child.unref();
      fs.closeSync(fd);
      const deadline = Date.now() + 10000;
      while (!socket && Date.now() < deadline) {
        if (closed) return;
        if (spawnError) throw spawnError;
        await new Promise((resolve) => setTimeout(resolve, 40));
        try {
          socket = await connect();
        } catch {
          if (!earlyExit && childExitTime && Date.now() - childExitTime > 300) {
            earlyExit = 'code 1';
          }
          if (earlyExit) {
            const log = path.join(path.dirname(socketPath), 'owner.log');
            throw new Error(`Awrit browser owner exited with ${earlyExit}; see ${log}${logTail(log, logStart)}`);
          }
          /* Lock winner may still be starting. */
        }
      }
      if (!socket)
        throw new Error('Awrit browser owner did not become ready; close incompatible old viewers');
    }
    if (closed) {
      socket.destroy();
      return;
    }
    const connection = socket;
    const send = (value: unknown) => {
      if (connection.writableLength > 1024 * 1024) {
        cleanup();
        return;
      }
      connection.write(encodeFrame('control', Buffer.from(JSON.stringify(value))));
    };
    terminalStarted = true;
    defaultOutput.setup();
    features = termEnableFeatures();
    if (!features.keyboard || !features.images)
      throw new Error(
        'This terminal lacks Kitty keyboard and graphics support. Run awrit in Kitty.',
      );
    const size = getWindowSize();
    let sourceWindowId = launch.sourceWindowId ?? process.env.AWRIT_SOURCE_WINDOW_ID;
    if (!sourceWindowId && process.env.KITTY_WINDOW_ID) {
      try {
        const { findKittyNeighborWindowId } = await import('../presentation/kittyDiscovery');
        sourceWindowId = await findKittyNeighborWindowId(process.env.KITTY_WINDOW_ID);
      } catch {}
    }
    send({
      type: 'attach',
      terminalScheme: process.env.AWRIT_TERMINAL_SCHEME === 'light' ? 'light' : 'dark',
      ...(process.env.AWRIT_TERMINAL_BACKGROUND && /^#[0-9a-f]{6}$/.test(process.env.AWRIT_TERMINAL_BACKGROUND)
        ? { terminalBackground: process.env.AWRIT_TERMINAL_BACKGROUND }
        : {}),
      version: 1,
      build,
      debugPort: launch.debugPort,
      ...(sourceWindowId ? { sourceWindowId } : {}),
      ...(process.env.KITTY_WINDOW_ID ? { kittyWindowId: process.env.KITTY_WINDOW_ID } : {}),
      url: launch.url ?? '',
      settings: launch.settings,
      ...(launch.android ? { android: launch.android } : {}),
      ...(launch.companion ? { companion: launch.companion } : {}),
      ...(process.env.AWRIT_PROFILE
        ? {
            profile: path.resolve(
              process.env.AWRIT_CALLER_CWD ?? process.cwd(),
              process.env.AWRIT_PROFILE,
            ),
          }
        : {}),
      size,
      features,
    });
    const decoder = new FrameDecoder();
    connection.on('data', (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind === 'control') {
            const control: unknown = JSON.parse(frame.payload.toString());
            if (!control || typeof control !== 'object' || !('type' in control))
              throw new Error('Invalid owner response');
            if (control.type === 'error') {
              process.exitCode = 1;
              cleanup();
              console.error(
                'message' in control && typeof control.message === 'string'
                  ? control.message
                  : 'Owner rejected attach',
              );
              return;
            }
            if (control.type !== 'attached' || !('build' in control) || control.build !== build)
              throw new Error('Incompatible Awrit owner');
          }
          if (frame.kind === 'output' && !process.stdout.write(frame.payload)) {
            connection.pause();
            process.stdout.once('drain', () => connection.resume());
          }
        }
      } catch (error) {
        process.exitCode = 1;
        cleanup();
        console.error(error instanceof Error ? error.message : String(error));
      }
    });
    connection.on('error', (error) => {
      process.exitCode = 1;
      cleanup();
      console.error(error.message);
    });
    connection.on('close', cleanup);
    stop = listenForInput((event) => {
      if (event.eventType === 'resize') send({ type: 'resize', size: getWindowSize() });
      else send({ type: 'input', event });
    }, 10);
    process.on('SIGWINCH', () => send({ type: 'resize', size: getWindowSize() }));
  } catch (error) {
    cleanup();
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
void main();
