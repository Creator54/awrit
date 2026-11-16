import { normalizePaneLaunch } from './options';
import { decodeAttach } from './attach';
import { startOwnerAgentIpc, type AgentPane } from './agentIpc';
import type { IpcServer } from '../ipc/socketServer';
import { ownerBuildIdentity } from './build';
import { ownerAssets } from './assets';
import { createPaneSession } from './paneSession';
import { createAdbControl } from '../adb/adbControl';
import { createCompanionHtmlFile } from '../presentation/companion';
import {
  initSessionWorkspace,
  cleanupCurrentSession,
  pruneDeadSessions,
} from '../session/workspace';
import { loadBrowserConfig } from '../browserConfig';
import { watchOwnerConfig } from './config';
import fs from 'node:fs';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { app, Menu, nativeTheme } from 'electron';
import { FrameDecoder } from './protocol';
import { TerminalWriter } from './transport';
import { ownerSocketPath } from './discovery';
import { PaneRegistry } from './panes';
import { createTerminalContext } from '../terminal/context';
import { createInputHandler } from '../inputHandler';
import { createWindowWithToolbar } from '../windows';
import { getProfileSession, flushProfileSessions } from '../session';

// Linux Chromium needs Vulkan enabled for WebGPU; preserve any existing feature flags.
if (process.platform === 'linux') {
  const features = app.commandLine.getSwitchValue('enable-features');
  if (!features.split(',').some((feature) => feature.split(/[<:]/, 1)[0] === 'Vulkan'))
    app.commandLine.appendSwitch('enable-features', [features, 'Vulkan'].filter(Boolean).join(','));
}

// Remote owners run without a display; the bridge passes --ozone-platform=headless.
const remoteOwner = process.argv.includes('--remote-owner');
if (remoteOwner) {
  // Keep the supervisor alive after the last page closes; the next client reuses it.
  // The owner quits on its own once idle.
  app.on('window-all-closed', () => {});
}

// This entry never initializes a terminal. The Electron lock owns storage, not a PTY.
const build = ownerBuildIdentity(process.argv[1]);
const ownerOptions = normalizePaneLaunch(process.argv.slice(2), process.cwd());
if (ownerOptions.debugPort !== 'disabled')
  app.commandLine.appendSwitch('remote-debugging-port', ownerOptions.debugPort);
// The supervisor lock owns remote-owner uniqueness; the local socket lock would
// block a remote owner on a host that also runs a local viewer.
const locked = remoteOwner || app.requestSingleInstanceLock();
if (!locked) app.exit(1);
Menu.setApplicationMenu(null);
const assets = ownerAssets(process.argv[1]);
let config: typeof import('../../config.js');
const stopConfigWatch = watchOwnerConfig(assets.config, (next) => {
  loadBrowserConfig(next);
  config = next;
}, (error) => console.error('Config reload failed:', error));
app.on('window-all-closed', () => {});
app.commandLine.appendSwitch('disable-blink-features', 'AutomationControlled');
const sockets = new Set<net.Socket>();
let server: net.Server | undefined;
let agentServer: IpcServer | undefined;
let remoteOwnerServer: import('../remote/owner').RunningOwner | undefined;
const agentPanes = new Map<string, AgentPane>();
let stopping = false;
let readyToQuit = false;
const panes = new PaneRegistry(() => void shutdown());
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (typeof remoteOwnerServer !== 'undefined') {
    try {
      await remoteOwnerServer.stop();
    } catch (error) {
      console.error('Remote owner stop failed:', error);
    }
  }
  stopConfigWatch();
  panes.shutdown();
  server?.close();
  for (const socket of sockets) socket.destroy();
  await agentServer?.stop();
  await flushProfileSessions();
  cleanupCurrentSession();
  readyToQuit = true;
  app.quit();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());

app.on('before-quit', event => {
  if (readyToQuit) return;
  event.preventDefault();
  void shutdown();
});
app.once('will-quit', cleanupCurrentSession);

app.whenReady().then(async () => {
  if (remoteOwner) {
    try {
      const { startElectronOwner } = await import('../remote/owner');
      remoteOwnerServer = await startElectronOwner(() => void shutdown());
    } catch (error) {
      console.error(
        'Remote owner failed:',
        error instanceof Error ? error.message : 'unknown error',
      );
      app.exit(1);
    }
    return;
  }
  initSessionWorkspace();
  const pruneTimer = setTimeout(pruneDeadSessions, 2000);
  pruneTimer.unref();
  nativeTheme.themeSource = 'dark';
  agentServer = await startOwnerAgentIpc(() => [...agentPanes.values()]);
  const socketPath = ownerSocketPath();
  // Only the Electron lock holder can remove its predecessor's transport socket.
  try {
    fs.unlinkSync(socketPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  server = net.createServer((socket) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    const connectionId = randomUUID();
    if (!panes.attach(connectionId)) {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const decoder = new FrameDecoder();
    const writer = new TerminalWriter(socket);
    let attaching = false;
    let handshaken = false;
    let session: ReturnType<typeof createPaneSession> | undefined;
    const timeout = setTimeout(() => {
      if (!handshaken) socket.destroy();
    }, 5000);
    socket.on('data', (chunk) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (frame.kind !== 'control') throw new Error('Client output forbidden');
          const msg: unknown = JSON.parse(frame.payload.toString());
          if (typeof msg !== 'object' || msg === null || !('type' in msg))
            throw new Error('Invalid control');
          if (!handshaken) {
            if (attaching) throw new Error('Attach already started');
            const request = decodeAttach(msg, build, ownerOptions.debugPort);
            attaching = true;
            handshaken = true;
            clearTimeout(timeout);
            session = createPaneSession({
              connectionId,
              build,
              socket,
              output: writer,
              assetDirectory: assets.directory,
              getConfig: () => config,
              agentPanes,
              request,
              createTerminal: createTerminalContext,
              createWindow: createWindowWithToolbar,
              createInputHandler,
              getProfileSession,
              createAdbControl,
              createCompanionFile: createCompanionHtmlFile,
            });
          } else session?.handle(msg);
        }
      } catch (error) {
        console.error(
          'Terminal connection rejected:',
          error instanceof Error ? error.message : 'invalid frame',
        );
        writer.writeControl(
          Buffer.from(
            JSON.stringify({
              type: 'error',
              message: error instanceof Error ? error.message : 'Invalid terminal request',
            }),
          ),
        );
        socket.end();
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      clearTimeout(timeout);
      session?.close();
      sockets.delete(socket);
      panes.detach(connectionId);
    });
  });
  server.on('error', () => void shutdown());
  server.listen(socketPath, () => fs.chmodSync(socketPath, 0o600));
});
