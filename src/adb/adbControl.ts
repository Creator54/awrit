import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { readAndroidKeyConfig } from '../designKey';
import type { CompanionConfig } from '../presentation/companion';
import { getAdbHtml } from './template';

const executeFile = promisify(execFile);
/** A launchable `package/activity`; no shell metacharacters (`$` inner classes are excluded). */
export const LAUNCH_COMPONENT = /^[A-Za-z][\w]*(\.\w+)+\/[\w.]+$/;

export function textInputCommand(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    /[^\x20-\x7e]/.test(value)
  ) {
    throw new Error('Text must contain 1–256 printable ASCII characters');
  }
  const quote = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
  // Android consumes %s as a space. Split literal %s across separate input commands.
  const commands: string[] = [];
  for (const [index, part] of value.split('%s').entries()) {
    if (index > 0) commands.push("input text '%'", "input text 's'");
    if (part) commands.push(`input text ${quote(part.replace(/ /g, '%s'))}`);
  }
  return commands.join(' && ');
}

export function computeStreamDimensions(
  deviceWidth: number,
  deviceHeight: number,
  maxSize?: number,
  viewport?: { width: number; height: number },
): { streamWidth: number; streamHeight: number } {
  let maxBound = 1600;
  if (maxSize !== undefined && Number.isInteger(maxSize) && maxSize > 0) {
    maxBound = maxSize;
  } else if (
    viewport &&
    Number.isFinite(viewport.width) &&
    viewport.width > 0 &&
    Number.isFinite(viewport.height) &&
    viewport.height > 0
  ) {
    const scale = Math.min(viewport.width / deviceWidth, viewport.height / deviceHeight);
    maxBound = Math.min(maxBound, Math.max(deviceWidth, deviceHeight) * scale);
  }
  const aspect = deviceWidth / deviceHeight;
  let streamW: number;
  let streamH: number;

  if (aspect <= 1) {
    streamH = Math.min(deviceHeight, maxBound);
    streamW = Math.round(streamH * aspect);
  } else {
    streamW = Math.min(deviceWidth, maxBound);
    streamH = Math.round(streamW / aspect);
  }

  // Ensure multiples of 8 for Android hardware video encoder compatibility
  streamW = Math.max(128, Math.round(streamW / 8) * 8);
  streamH = Math.max(128, Math.round(streamH / 8) * 8);

  return { streamWidth: streamW, streamHeight: streamH };
}

const ADB_FALLBACKS = ['/run/current-system/sw/bin/adb', '/usr/bin/adb'];

export function findBinary(name: string, fallbackPaths: string[] = []): string {
  const envPath = process.env.PATH || '';
  const dirs = envPath.split(path.delimiter);
  for (const dir of dirs) {
    const candidate = path.join(dir, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  for (const fallback of fallbackPaths) {
    if (existsSync(fallback)) {
      return fallback;
    }
  }

  // Standard platform fallbacks (macOS Homebrew, Linux system, Android SDK, Nix profiles)
  const home = process.env.HOME || '';
  const user = process.env.USER || '';
  const standardFallbacks = [
    '/run/current-system/sw/bin',
    path.join(home, '.nix-profile', 'bin'),
    path.join(home, '.local', 'bin'),
    `/etc/profiles/per-user/${user}/bin`,
    '/nix/var/nix/profiles/default/bin',
    '/usr/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin', // macOS Apple Silicon Homebrew
    path.join(home, 'Library', 'Android', 'sdk', 'platform-tools'), // macOS Android SDK
    path.join(home, 'Android', 'Sdk', 'platform-tools'), // Linux Android SDK
    process.env.ANDROID_HOME ? path.join(process.env.ANDROID_HOME, 'platform-tools') : '',
    process.env.ANDROID_SDK_ROOT ? path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools') : '',
  ].filter(Boolean);

  for (const fallback of standardFallbacks) {
    const candidate = path.join(fallback, name);
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return name;
}

export async function detectAdbDevice(explicitDevice?: string, adbBin = 'adb'): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(adbBin, ['devices']);
    let stdout = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('Could not list ADB devices'));
        return;
      }
      const lines = stdout.split('\n');
      const devices: string[] = [];
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1] === 'device') {
          devices.push(parts[0]);
        }
      }
      const requested = explicitDevice?.trim();
      if (requested && !devices.includes(requested)) {
        reject(new Error(`ADB device ${requested} is not connected`));
      } else if (devices.length === 0) {
        reject(new Error('No connected ADB device found'));
      } else {
        resolve(requested || devices[0]);
      }
    });
    proc.on('error', reject);
  });
}

export async function getDeviceResolution(
  adbBin: string,
  device: string,
): Promise<{ width: number; height: number }> {
  return (await readDeviceResolution(adbBin, device)) ?? { width: 1080, height: 2400 };
}

async function readDeviceResolution(
  adbBin: string,
  device: string,
): Promise<{ width: number; height: number } | null> {
  return new Promise((resolve) => {
    // `wm size` reports the natural (portrait) size; `cur=` in the window dump follows rotation.
    const proc = spawn(
      adbBin,
      ['-s', device, 'shell', 'wm', 'size', ';', 'dumpsys', 'window', 'displays'],
      { timeout: 2000 },
    );
    let stdout = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.on('close', () => {
      if (!/\bcur=\d+x\d+|(?:Override|Physical) size: \d+x\d+/.test(stdout)) {
        resolve(null);
        return;
      }
      const current = stdout.match(/\bcur=(\d+)x(\d+)/);
      if (current) {
        resolve({ width: Number(current[1]), height: Number(current[2]) });
        return;
      }
      let width = 1080;
      let height = 2400;
      for (const line of stdout.split('\n')) {
        if (line.includes('Override size:')) {
          const dims = line.split('Override size:')[1].trim().split('x');
          if (dims.length === 2) {
            width = parseInt(dims[0], 10) || width;
            height = parseInt(dims[1], 10) || height;
            break;
          }
        } else if (line.includes('Physical size:')) {
          const dims = line.split('Physical size:')[1].trim().split('x');
          if (dims.length === 2) {
            width = parseInt(dims[0], 10) || width;
            height = parseInt(dims[1], 10) || height;
          }
        }
      }
      resolve({ width, height });
    });
    proc.on('error', () => {
      resolve(null);
    });
  });
}

export interface AdbServerInstance {
  url: string;
  port: number;
  device: string;
  /** Device screen size in pixels, refreshed when the pipeline notices a rotation. */
  resolution: () => { width: number; height: number };
  resize: (viewport: { width: number; height: number }) => void;
  stop: () => void;
}

let activeInstance: AdbServerInstance | null = null;

/** Largest side accepted by the raw frame parser; matches the protocol media limit. */
const MAX_RAW_FRAME_SIDE = 4096;

/**
 * Splits FFmpeg rawvideo BGRA output into exact frames for a remote frame sink.
 * Chunk boundaries and buffered frames are coalesced: only the newest complete frame
 * is handed over, with a stable copy, and incomplete bytes stay bounded by one frame.
 */
export function createRawFrameReader(
  width: number,
  height: number,
  receive: (data: Buffer, width: number, height: number) => void,
): (chunk: Buffer) => void {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_RAW_FRAME_SIDE ||
    height > MAX_RAW_FRAME_SIDE
  ) {
    throw new Error('Invalid raw frame size');
  }
  const frameBytes = width * height * 4;
  let pending: Buffer = Buffer.alloc(0);
  return (chunk: Buffer) => {
    if (!chunk.length) return;
    const all = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const complete = Math.floor(all.length / frameBytes);
    if (complete > 0) {
      const start = (complete - 1) * frameBytes;
      receive(Buffer.from(all.subarray(start, start + frameBytes)), width, height);
    }
    const rest = all.length - complete * frameBytes;
    pending = rest ? Buffer.from(all.subarray(all.length - rest)) : Buffer.alloc(0);
  };
}

export interface AdbStreamOptions {
  companion?: CompanionConfig;
  maxSize?: number;
  bitrate?: string;
  viewport?: { width: number; height: number };
  overlay?: boolean;
  /**
   * Internal remote-owner hook: deliver decoded BGRA frames instead of MJPEG.
   * Only `createAndroidPane` sets it; loopback HTTP clients keep the MJPEG default.
   */
  onFrame?: (data: Buffer, width: number, height: number) => void;
}

export async function startAdbControl(
  targetDevice?: string,
  streamOpts: AdbStreamOptions = {},
): Promise<AdbServerInstance> {
  if (activeInstance) return activeInstance;
  const instance = await createAdbControl(targetDevice, streamOpts);
  const legacyInstance: AdbServerInstance = {
    ...instance,
    stop: () => {
      instance.stop();
      if (activeInstance === legacyInstance) activeInstance = null;
    },
  };
  activeInstance = legacyInstance;
  return legacyInstance;
}

/** Independent stream lifetime for a terminal pane; no process-wide device selection. */
export async function createAdbControl(
  targetDevice?: string,
  streamOpts: AdbStreamOptions = {},
): Promise<AdbServerInstance> {
  const adbBin = findBinary('adb', ADB_FALLBACKS);
  const ffmpegBin = findBinary('ffmpeg', []);
  if (!existsSync(adbBin) || !existsSync(ffmpegBin)) {
    throw new Error('ADB control requires adb and ffmpeg on PATH');
  }
  const device = await detectAdbDevice(targetDevice, adbBin);
  let resolution = await getDeviceResolution(adbBin, device);

  const activeClients = new Set<ServerResponse>();
  const frameHeader = Buffer.from('--frame\r\nContent-Type: image/jpeg\r\n\r\n');
  // Chromium waits for the following part's headers before displaying a JPEG.
  const frameTail = Buffer.concat([Buffer.from('\r\n'), frameHeader]);
  let latestFrame: Buffer | null = null;
  let fpsVal = 0.0;
  let fpsCount = 0;
  let fpsT0 = Date.now();
  let lastFrameSent = 0;

  let pRec: ChildProcess | null = null;
  let pFfmpeg: ChildProcess | null = null;
  let isRunning = true;
  let restartTimeout: NodeJS.Timeout | null = null;
  let resizeTimeout: NodeJS.Timeout | null = null;
  let viewport = streamOpts.viewport;
  let streamSize = '';

  // screenrecord keeps its start size, so restart it when the device rotates
  // (from the viewer, an app or the device itself).
  let connected = true;
  let checkingRotation = false;

  async function launchPipeline() {
    if (!isRunning) return;

    // Dynamically refresh resolution upon pipeline launch/restart (e.g. rotation)
    const current = await readDeviceResolution(adbBin, device);
    if (!isRunning) return;
    connected = current !== null;
    if (current) resolution = current;
    else {
      latestFrame = null;
      fpsVal = 0;
    }
    const { streamWidth, streamHeight } = computeStreamDimensions(
      resolution.width,
      resolution.height,
      streamOpts.maxSize,
      viewport,
    );
    const nextSize = `${streamWidth}x${streamHeight}`;
    if (nextSize !== streamSize) {
      // A new encoder size needs its own short recording to flush a static first frame.
      latestFrame = null;
      fpsVal = 0;
      fpsCount = 0;
      lastFrameSent = 0;
      streamSize = nextSize;
    }
    const bitRateArg =
      streamOpts.bitrate && /^[1-9][0-9]*[kKmMgG]?$/.test(streamOpts.bitrate)
        ? `--bit-rate=${streamOpts.bitrate}`
        : '--bit-rate=4M';

    const recorder = spawn(
      adbBin,
      [
        '-s',
        device,
        'exec-out',
        'screenrecord',
        '--output-format=h264',
        `--size=${streamWidth}x${streamHeight}`,
        bitRateArg,
        // End the first recording promptly so a static screen's lone frame is flushed.
        `--time-limit=${latestFrame ? 180 : 1}`,
        '-',
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );

    // ponytail: one MJPEG worker per 1080p of pixels; profile slower CPUs before tuning.
    const encoderThreads = Math.min(
      availableParallelism(),
      Math.ceil((streamWidth * streamHeight) / (1920 * 1080)),
    );
    const encoder = spawn(
      ffmpegBin,
      [
        '-probesize',
        '32',
        '-analyzeduration',
        '0',
        '-f',
        'h264',
        '-flags',
        'low_delay',
        '-fflags',
        'discardcorrupt',
        '-threads',
        '1',
        '-i',
        '-',
        '-threads',
        String(encoderThreads),
        ...(streamOpts.onFrame
          ? ['-f', 'rawvideo', '-pix_fmt', 'bgra', '-']
          : ['-f', 'mjpeg', '-q:v', '5', '-']),
      ],
      { stdio: ['pipe', 'pipe', 'ignore'] },
    );

    pRec = recorder;
    pFfmpeg = encoder;
    if (streamOpts.onFrame) {
      // A remote owner takes decoded BGRA frames; the loopback HTTP clients keep MJPEG.
      encoder.stdout?.on(
        'data',
        createRawFrameReader(streamWidth, streamHeight, streamOpts.onFrame),
      );
    }
    if (recorder.stdout && encoder.stdin) {
      recorder.stdout.pipe(encoder.stdin);
      encoder.stdin.on('error', () => {}); // The recorder may outlive a failed encoder.
    }

    let buffer: Buffer = Buffer.alloc(0);
    const FRAME_START = Buffer.from([0xff, 0xd8]);
    const FRAME_END = Buffer.from([0xff, 0xd9]);

    encoder.stdout?.on('data', (chunk: Buffer) => {
      // Raw mode has its own parser; this byte scan only serves MJPEG clients.
      if (typeof streamOpts !== 'undefined' && streamOpts.onFrame) return;
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      let parsedFrame = false;
      while (true) {
        const start = buffer.indexOf(FRAME_START);
        if (start === -1) {
          if (buffer.length > 4) {
            buffer = buffer.subarray(buffer.length - 4);
          }
          break;
        }

        const end = buffer.indexOf(FRAME_END, start);
        if (end === -1) {
          buffer = buffer.subarray(start);
          break;
        }

        const frame = buffer.subarray(start, end + 2);
        buffer = buffer.subarray(end + 2);

        if (connected && frame.length > 1000) {
          latestFrame = frame;
          parsedFrame = true;
        }
      }
      const now = Date.now();
      if (parsedFrame && latestFrame && now - lastFrameSent >= 16) {
        lastFrameSent = now;
        fpsCount++;
        let packet: Buffer | undefined;
        for (const client of activeClients) {
          if (!client.writableNeedDrain) {
            packet ??= Buffer.concat([latestFrame, frameTail]);
            client.write(packet);
          }
        }
      }
    });

    let finished = false;
    const cleanupSubprocesses = () => {
      if (finished) return;
      finished = true;
      try {
        encoder.kill('SIGKILL');
      } catch {}
      try {
        recorder.kill('SIGKILL');
      } catch {}
      if (isRunning) {
        if (restartTimeout) clearTimeout(restartTimeout);
        restartTimeout = setTimeout(() => {
          restartTimeout = null;
          launchPipeline();
        }, 500);
      }
    };

    // The pipe ends with the recorder. Let FFmpeg decode its final buffered frame
    // before its own close handler restarts the pipeline.
    encoder.on('close', cleanupSubprocesses);
    recorder.on('error', cleanupSubprocesses);
    encoder.on('error', cleanupSubprocesses);
  }

  const html = getAdbHtml(
    resolution.width,
    resolution.height,
    device,
    streamOpts.companion,
    streamOpts.overlay,
    readAndroidKeyConfig(),
  );

  const controls = new AbortController();
  const shell = (args: string[]) =>
    executeFile(adbBin, ['-s', device, 'shell', ...args], {
      timeout: 3000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      signal: controls.signal,
    });
  // A gesture lift must outlive stop(), which aborts `controls`.
  const shellUnaborted = (args: string[]) =>
    executeFile(adbBin, ['-s', device, 'shell', ...args], {
      timeout: 3000,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
    });
  // One long-lived `adb shell` keeps input commands cheap; each fresh adb costs ~120ms of spawn.
  // Each command is acknowledged by a marker the shell echoes afterwards, so a dead shell
  // fails the request instead of a write that only reached a broken pipe.
  const CONTROL_ACK_TIMEOUT_MS = 5000;
  const CONTROL_RETRY_MS = 5000;
  const MAX_PENDING_CONTROLS = 64;
  // Random per instance, so device output cannot forge an acknowledgement.
  const markerPrefix = `__awrit_${Math.random().toString(36).slice(2, 10)}_`;
  let controlShell: ChildProcess | null = null;
  let controlRetryAt = 0;
  let controlOutput = '';
  let controlSeq = 0;
  let writeBarrier = Promise.resolve();
  let releaseWriteBarrier: (() => void) | null = null;
  const ackWaiters = new Map<number, (ok: boolean) => void>();
  // Last point of a gesture whose finger is still down, as far as the device knows.
  let gesturePoint: { x: number; y: number } | null = null;
  // The one gesture identity allowed to touch that finger, with its newest accepted sequence.
  // Bounded to a single record: an event from any other identity is reported skipped.
  let gestureIdentity: { id: string; epoch: number; seq: number; sealed: boolean } | null = null;
  // A viewer that vanishes mid-gesture leaves the finger down until something lifts it.
  const GESTURE_IDLE_MS = 1000;
  let gestureIdleTimer: NodeJS.Timeout | null = null;

  function clearGestureIdle(): void {
    if (gestureIdleTimer) clearTimeout(gestureIdleTimer);
    gestureIdleTimer = null;
  }

  function armGestureIdle(): void {
    clearGestureIdle();
    gestureIdleTimer = setTimeout(() => {
      gestureIdleTimer = null;
      liftGesture();
    }, GESTURE_IDLE_MS);
  }

  function liftGesture(retry = true): void {
    clearGestureIdle();
    if (!gesturePoint) return;
    const point = gesturePoint;
    gesturePoint = null;
    // A fresh adb shell is the reliable path: the persistent one may be the reason we are here.
    shellUnaborted(['input', 'motionevent', 'UP', String(point.x), String(point.y)]).catch(() => {
      // Try once more unless a newer gesture took over the finger meanwhile.
      if (retry && !gesturePoint && isRunning) {
        gesturePoint = point;
        liftGesture(false);
      }
    });
  }

  function failControlShell(child: ChildProcess): void {
    if (controlShell !== child) return;
    controlShell = null;
    controlRetryAt = Date.now() + CONTROL_RETRY_MS;
    // What the dead shell read may never have run, so report failure instead of replaying
    // a command that could already have landed.
    for (const settle of [...ackWaiters.values()]) settle(false);
    ackWaiters.clear();
    // A write waiting for `drain` from this shell would block every later command.
    if (releaseWriteBarrier) releaseWriteBarrier();
    releaseWriteBarrier = null;
    writeBarrier = Promise.resolve();
    // Nobody reads this shell any more, so end it instead of leaking the process.
    try {
      child.stdin?.end();
    } catch {}
    try {
      child.kill('SIGKILL');
    } catch {}
    if (isRunning) liftGesture();
  }

  function readControlOutput(child: ChildProcess, chunk: string): void {
    if (controlShell !== child) return;
    controlOutput += chunk;
    let newline = controlOutput.indexOf('\n');
    while (newline !== -1) {
      const line = controlOutput.slice(0, newline).trim();
      controlOutput = controlOutput.slice(newline + 1);
      newline = controlOutput.indexOf('\n');
      // Device chatter can share the line, so the marker is matched wherever it lands.
      const at = line.indexOf(markerPrefix);
      if (at === -1) continue;
      const [rawId, status] = line.slice(at + markerPrefix.length).split(' ');
      const settle = ackWaiters.get(Number(rawId));
      if (!settle) continue;
      ackWaiters.delete(Number(rawId));
      settle(status === '0');
    }
    // Device chatter that never completes a line must not grow forever, but the unterminated
    // tail may already hold the start of a marker line, so keep its end.
    if (controlOutput.length > 4096) controlOutput = controlOutput.slice(-4096);
  }

  function ensureControlShell(): ChildProcess | null {
    if (controlShell) return controlShell;
    if (!isRunning || Date.now() < controlRetryAt) return null;
    let child: ChildProcess;
    try {
      child = spawn(adbBin, ['-s', device, 'shell'], { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      controlRetryAt = Date.now() + CONTROL_RETRY_MS;
      return null;
    }
    controlShell = child;
    controlOutput = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => readControlOutput(child, chunk));
    child.stdin?.on('error', () => failControlShell(child));
    child.on('error', () => failControlShell(child));
    child.on('exit', () => failControlShell(child));
    return child;
  }

  // Writes stay ordered so gestures arrive in order; a full pipe waits for drain instead of
  // buffering without bound.
  function writeControl(child: ChildProcess, line: string): void {
    const ready = writeBarrier;
    let release: () => void = () => {};
    writeBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    releaseWriteBarrier = release;
    ready.then(() => {
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed) {
        release();
        failControlShell(child);
        return;
      }
      try {
        if (stdin.write(line)) {
          release();
          return;
        }
        stdin.once('drain', release);
      } catch {
        release();
        failControlShell(child);
      }
    });
  }

  /** Resolves true only when this command's own marker comes back from the device shell. */
  function sendControl(command: string): Promise<boolean> | null {
    const child = ensureControlShell();
    if (!child) return null;
    const id = ++controlSeq;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const settle = (ok: boolean) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        ackWaiters.delete(id);
        resolve(ok);
      };
      timer = setTimeout(() => {
        settle(false);
        // A shell that stopped echoing is stuck; replace it after the cooldown.
        failControlShell(child);
      }, CONTROL_ACK_TIMEOUT_MS);
      ackWaiters.set(id, settle);
      writeControl(child, `${command}; echo ${markerPrefix}${id} $?\n`);
    });
  }

  const runControl = (args: string[]): Promise<boolean> => {
    const pending = sendControl(args.join(' '));
    // Without a usable persistent shell the one-shot path is the honest fallback.
    return (pending ?? shell(args).then(() => true)).catch(() => false);
  };

  // Backpressure: a command counts as pending until the device shell acknowledges it.
  let pendingControls = 0;
  function queueControl(action: () => Promise<unknown>, exemptFromCap = false): Promise<boolean> {
    // A lift is never refused: dropping it is what leaves the device's finger down.
    if (!isRunning || (!exemptFromCap && pendingControls >= MAX_PENDING_CONTROLS))
      return Promise.resolve(false);
    pendingControls++;
    return action()
      .then((value) => value !== false)
      .catch(() => false)
      .finally(() => {
        pendingControls--;
      });
  }

  const server = http.createServer((req: IncomingMessage, res: ServerResponse) => {
    const address = server.address();
    const origin = address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : '';
    if (
      req.headers.host !== origin.slice(7) ||
      (req.headers.origin && req.headers.origin !== origin)
    ) {
      res.writeHead(403).end();
      return;
    }
    const url = new URL(req.url || '/', origin);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/stream') {
      res.writeHead(200, {
        'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        Connection: 'close',
        Pragma: 'no-cache',
      });
      res.write(frameHeader);
      if (latestFrame) {
        res.write(Buffer.concat([latestFrame, frameTail]));
      }
      activeClients.add(res);
      res.on('close', () => activeClients.delete(res));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/status') {
      const now = Date.now();
      if (now - fpsT0 >= 1000) {
        fpsVal = Math.round(((fpsCount * 1000) / (now - fpsT0)) * 10) / 10;
        fpsCount = 0;
        fpsT0 = now;
      }
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });
      res.end(
        JSON.stringify({
          fps: fpsVal,
          hasFrame: Boolean(latestFrame),
          w: resolution.width,
          h: resolution.height,
          connected,
        }),
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/apps') {
      executeFile(
        adbBin,
        [
          '-s',
          device,
          'shell',
          'cmd package query-activities --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER',
        ],
        { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024, signal: controls.signal },
      ).then(
        ({ stdout }) => {
          const apps = stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => LAUNCH_COMPONENT.test(line));
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ apps }));
        },
        () => {
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end('Cannot list the apps');
        },
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/ui') {
      // A uiautomator dump takes 1-3 s and needs its own adb call, not the input shell.
      executeFile(
        adbBin,
        [
          '-s',
          device,
          'shell',
          // rm first so a failed dump cannot return the previous screen; uiautomator can exit 0
          // without writing the file ("could not get idle state"), so report its output instead.
          'f=/data/local/tmp/awrit-ui.xml; rm -f $f; out=$(uiautomator dump $f 2>&1); [ -s $f ] && cat $f || { echo "$out" >&2; exit 1; }',
        ],
        {
          timeout: 12_000,
          killSignal: 'SIGKILL',
          maxBuffer: 8 * 1024 * 1024,
          signal: controls.signal,
        },
      ).then(
        ({ stdout }) => {
          res.writeHead(200, { 'Content-Type': 'application/xml', 'Cache-Control': 'no-store' });
          res.end(stdout);
        },
        (error: unknown) => {
          const stderr = Reflect.get(Object(error), 'stderr');
          const detail = (typeof stderr === 'string' && stderr.trim()) || String(error);
          res.writeHead(502, { 'Content-Type': 'text/plain' });
          res.end(`Cannot read the screen elements: ${detail.slice(0, 300)}`);
        },
      );
      return;
    }

    if (req.method === 'GET' && url.pathname === '/screenshot') {
      if (latestFrame) {
        res.writeHead(200, {
          'Content-Type': 'image/jpeg',
          'Content-Disposition': `attachment; filename="screenshot-${Date.now()}.jpg"`,
          'Cache-Control': 'no-cache, no-store, must-revalidate',
        });
        res.end(latestFrame);
      } else {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('No frame available');
      }
      return;
    }

    if (req.method === 'POST') {
      if (
        !['/tap', '/swipe', '/gesture', '/key', '/text', '/wake', '/rotate', '/launch'].includes(
          url.pathname,
        )
      ) {
        res.writeHead(404).end();
        return;
      }
      if (req.headers['content-type'] !== 'application/json') {
        res.writeHead(415).end();
        return;
      }
      let bodyStr = '';
      req.on('data', (c) => {
        bodyStr += c.toString();
        if (bodyStr.length > 4096) {
          req.pause();
          res.writeHead(413).end();
        }
      });
      req.on('end', async () => {
        if (res.writableEnded) return;
        try {
          const body = JSON.parse(bodyStr || '{}');
          const coordinate = (value: unknown, limit: number): string => {
            if (!Number.isInteger(value) || (value as number) < 0 || (value as number) >= limit) {
              throw new Error('invalid coordinate');
            }
            return String(value);
          };
          // A gesture id is a bounded printable token and its counters are safe integers.
          const gestureToken = (value: unknown): string => {
            if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(value)) {
              throw new Error('invalid gesture id');
            }
            return value;
          };
          const gestureCounter = (value: unknown): number => {
            if (!Number.isSafeInteger(value) || (value as number) < 0) {
              throw new Error('invalid gesture sequence');
            }
            return value as number;
          };
          let args: string[];
          // Set by a gesture request so the response can settle its finger bookkeeping.
          let phase: 'down' | 'move' | 'up' | null = null;
          // The identity record this request claimed, so a late reply cannot settle a newer one.
          let claim: { id: string; epoch: number; seq: number; sealed: boolean } | null = null;
          let lifting: { x: number; y: number } | null = null;
          if (url.pathname === '/tap') {
            args = [
              'input',
              'tap',
              coordinate(body.x, resolution.width),
              coordinate(body.y, resolution.height),
            ];
          } else if (url.pathname === '/swipe') {
            const ms = body.ms;
            if (!Number.isInteger(ms) || (ms as number) < 50 || (ms as number) > 2000) {
              throw new Error('invalid duration');
            }
            args = [
              'input',
              'swipe',
              coordinate(body.x1, resolution.width),
              coordinate(body.y1, resolution.height),
              coordinate(body.x2, resolution.width),
              coordinate(body.y2, resolution.height),
              String(ms),
            ];
          } else if (url.pathname === '/gesture') {
            const requested = body.phase;
            if (requested !== 'down' && requested !== 'move' && requested !== 'up') {
              throw new Error('invalid phase');
            }
            const id = gestureToken(body.id);
            const epoch = gestureCounter(body.epoch);
            const seq = gestureCounter(body.seq);
            const active =
              gestureIdentity && gestureIdentity.id === id && gestureIdentity.epoch === epoch
                ? gestureIdentity
                : null;
            // Only the tracked gesture may reach the device finger. Older events are reported
            // skipped rather than written, so a late move, lift or press cannot reopen a finger
            // the viewer no longer owns. A lift with no tracked gesture still lifts, which is
            // what recovers a finger after a viewer restart.
            const stale =
              requested === 'down'
                ? active
                  ? // A sealed press is finished: reopening it would revive an identity whose
                    // finger the device has already released.
                    active.sealed || seq <= active.seq
                  : Boolean(
                      gestureIdentity && gestureIdentity.id === id && epoch < gestureIdentity.epoch,
                    )
                : requested === 'move'
                  ? !active || active.sealed || seq <= active.seq
                  : // A sealed identity may still be lifted again with a newer sequence; lifting
                    // twice is harmless, while a stale or duplicate lift is not written.
                    gestureIdentity !== null && (!active || seq <= active.seq);
            if (stale) {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ ok: true, skipped: true }));
              return;
            }
            // A different identity may not press while the tracked finger is still down, even
            // with a newer epoch. The current owner keeps the tracker until its lift is
            // acknowledged, so its lift stays accepted; the idle watchdog clears a failed lift
            // and then frees the finger for a new owner.
            if (requested === 'down' && !active && gesturePoint) {
              res.writeHead(409, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'gesture in progress' }));
              return;
            }
            // Sealing at admission keeps a move still on the wire from re-pressing the finger.
            // A lift can arrive after the screen resized, so clamp it instead of rejecting it
            // and leaving the device's finger down.
            const clamp = (value: unknown, limit: number): string =>
              String(Math.max(0, Math.min(limit - 1, Math.round(Number(value) || 0))));
            if (requested === 'up') {
              // Prefer where the viewer released the finger over the last move, so the lift does
              // not jump backwards.
              const reported =
                Number.isFinite(body.x) && Number.isFinite(body.y)
                  ? { x: Number(body.x), y: Number(body.y) }
                  : null;
              const point = reported ?? gesturePoint;
              if (!point) throw new Error('invalid coordinate');
              lifting = gesturePoint;
              args = [
                'input',
                'motionevent',
                'UP',
                clamp(point.x, resolution.width),
                clamp(point.y, resolution.height),
              ];
            } else {
              const x = coordinate(body.x, resolution.width);
              const y = coordinate(body.y, resolution.height);
              gesturePoint = { x: Number(x), y: Number(y) };
              args = ['input', 'motionevent', requested.toUpperCase(), x, y];
            }
            // Only a payload that passed validation may claim the identity.
            gestureIdentity = { id, epoch, seq, sealed: requested === 'up' };
            // The reply may land after a watchdog lift or a newer owner; only this claim may
            // then change the tracker.
            claim = gestureIdentity;
            phase = requested;
          } else if (url.pathname === '/key') {
            if (Array.isArray(body.keycodes)) {
              if (
                body.keycodes.length === 0 ||
                body.keycodes.length > 3 ||
                !body.keycodes.every(
                  (k: unknown) => typeof k === 'number' && Number.isInteger(k) && k > 0 && k < 1000,
                )
              ) {
                throw new Error('invalid keycodes');
              }
              args = ['input', 'keycombination', ...body.keycodes.map(String)];
            } else if (
              typeof body.keycode === 'string' &&
              /^KEYCODE_[A-Z0-9_]+$/.test(body.keycode)
            ) {
              args = ['input', 'keyevent', body.keycode];
            } else {
              throw new Error('invalid keycode');
            }
          } else if (url.pathname === '/text') {
            args = [textInputCommand(body.text)];
          } else if (url.pathname === '/launch') {
            // The component runs in the device shell, so it must match the strict pattern.
            if (typeof body.component !== 'string' || !LAUNCH_COMPONENT.test(body.component)) {
              throw new Error('invalid component');
            }
            args = ['am', 'start', '-n', body.component];
          } else if (url.pathname === '/wake') {
            // KEYCODE_WAKEUP is a no-op when the screen is already on, unlike POWER.
            args = ['input', 'keyevent', 'KEYCODE_WAKEUP'];
          } else if (url.pathname === '/rotate') {
            // Toggle screen orientation between portrait and landscape
            // First check user_rotation setting, toggle 0 (portrait) <-> 1 (landscape 90 deg)
            args = [
              'content',
              'insert',
              '--uri',
              'content://settings/system',
              '--bind',
              'name:s:accelerometer_rotation',
              '--bind',
              'value:i:0',
            ];
            await queueControl(() => shell(args));
            const { stdout } = await shell(['settings', 'get', 'system', 'user_rotation']);
            const currentRot = parseInt(stdout.trim(), 10) || 0;
            const nextRot = (currentRot + 1) % 4;
            args = ['settings', 'put', 'system', 'user_rotation', String(nextRot)];
          } else {
            res.writeHead(404).end();
            return;
          }
          const success = await queueControl(() => runControl(args), phase === 'up');
          if (phase === 'down' || phase === 'move') {
            if (!success && phase === 'down' && gestureIdentity === claim) {
              // The press never landed, so hold no claim that would refuse the next viewer.
              gestureIdentity = null;
              gesturePoint = null;
              clearGestureIdle();
            } else if (gesturePoint && gestureIdentity === claim) {
              // A viewer that stops sending moves may be gone; a late completion must not
              // re-arm the idle lift of a newer tracker.
              armGestureIdle();
            }
          } else if (phase === 'up') {
            if (success && gesturePoint === lifting) {
              // Keep the tracker until the lift is acknowledged, so one that was refused or lost
              // is retried instead of leaving the device's finger down.
              gesturePoint = null;
              clearGestureIdle();
            } else if (!success && gesturePoint && gestureIdentity === claim) {
              armGestureIdle();
            }
          }
          if (res.writableEnded) return;
          res.writeHead(success ? 200 : 502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(success ? { ok: true } : { error: 'ADB command failed' }));
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid payload' }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve(addr.port);
      } else {
        resolve(8880);
      }
    });
  });

  const rotationWatch = setInterval(async () => {
    if (!isRunning || checkingRotation || restartTimeout || !pRec || pRec.killed) return;
    checkingRotation = true;
    const current = await readDeviceResolution(adbBin, device);
    checkingRotation = false;
    if (!isRunning) return;
    connected = current !== null;
    if (!connected) {
      latestFrame = null;
      fpsVal = 0;
    }
    if (current && (current.width !== resolution.width || current.height !== resolution.height)) {
      pRec?.kill('SIGTERM');
    }
  }, 2000);

  const instance: AdbServerInstance = {
    url: `http://127.0.0.1:${port}/`,
    port,
    device,
    resolution: () => ({ width: resolution.width, height: resolution.height }),
    resize: (nextViewport) => {
      if (
        !isRunning ||
        !Number.isFinite(nextViewport.width) ||
        nextViewport.width <= 0 ||
        !Number.isFinite(nextViewport.height) ||
        nextViewport.height <= 0
      )
        return;
      viewport = nextViewport;
      if (resizeTimeout) clearTimeout(resizeTimeout);
      resizeTimeout = setTimeout(() => {
        resizeTimeout = null;
        const next = computeStreamDimensions(
          resolution.width,
          resolution.height,
          streamOpts.maxSize,
          viewport,
        );
        if (`${next.streamWidth}x${next.streamHeight}` !== streamSize) {
          // Ending the recorder lets FFmpeg drain before the existing restart path runs.
          pRec?.kill('SIGTERM');
        }
      }, 250);
    },
    stop: () => {
      isRunning = false;
      clearInterval(rotationWatch);
      // Lift a finger that is still down before the shell that owns it dies.
      liftGesture();
      if (resizeTimeout) clearTimeout(resizeTimeout);
      if (restartTimeout) {
        clearTimeout(restartTimeout);
        restartTimeout = null;
      }
      controls.abort();
      try {
        controlShell?.kill('SIGKILL');
      } catch {}
      controlShell = null;
      for (const client of activeClients) {
        try {
          client.end();
        } catch {}
      }
      activeClients.clear();
      try {
        pFfmpeg?.kill('SIGKILL');
      } catch {}
      try {
        pRec?.kill('SIGKILL');
      } catch {}
      try {
        server.close();
      } catch {}
    },
  };

  try {
    await launchPipeline();
  } catch (error) {
    instance.stop();
    throw error;
  }
  return instance;
}

export function stopAdbControl(): void {
  if (activeInstance) {
    activeInstance.stop();
  }
}
