import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { TermEvent, WindowSize } from 'awrit-native-rs';
import type { PaneSettings } from '../browserOwner/options';
import { encodeFrame, FrameDecoder } from '../browserOwner/protocol';
import type { TerminalContext } from '../terminal/context';
import { createTerminalContext } from '../terminal/context';
import { type ArtifactOffer, parseArtifactOffer, receiveArtifact } from './artifacts';
import { createForwardPortScanner, forwardedUrl } from './forward';
import { createUploadChooser } from './picker';
import type { ControlMessage, InputEvent, JsonValue, Modifier, PointerButton } from './protocol';
import { MediaDecoder, parseControl } from './protocol';
import type { RemotePaneServer, RemoteRequestType } from './registry';
import { startRemotePane } from './registry';
import type { RemoteRenderer } from './renderer';
import { createRemoteRenderer } from './renderer';
import { sshArgv, type RemoteForward } from './sshCommand';
import { relayRemoteStderr } from './stderr';
import { type ChosenUpload, touching } from './uploadSource';
import { writeUpload } from './uploadWriter';

/** One ssh child: frames go to its stdin, the owner's bytes arrive on stdout. */
export interface RemoteLane {
  readonly stdin: Writable;
  readonly stdout: Readable;
  /** ssh stderr, when the lane has one; a forwarded lane reads it for the allocated port. */
  readonly stderr?: Readable;
  /** Called once when the child exits or fails to spawn; `failure` is a plain reason. */
  onClose(listener: (failure?: string) => void): void;
  kill(): void;
}

export interface RemoteClientDeps {
  android?: string;
  alias: string;
  url: string;
  /** Absolute path of the awrit runtime on the host. */
  runtimePath: string;
  terminal: TerminalContext;
  size: () => WindowSize;
  spawn: (argv: string[]) => RemoteLane;
  /** Terminal input source; returns an unsubscribe. */
  input: (handler: (event: TermEvent) => void) => () => void;
  /** Terminal resize signal; returns an unsubscribe. */
  onResize: (handler: () => void) => () => void;
  /** Local loopback port forwarded to the remote host over the control lane. */
  forward?: number;
  /** A page left by Disconnect; attached instead of creating a new one. */
  session?: string;
  stderr: (line: string) => void;
  writeClipboard?: (text: string) => void;
  notify?: (message: string) => void;
  build?: string;
  clock?: ClientClock;
  /** The owner answered with a session; the pane registry can start advertising it. */
  onReady?: (session: string) => void;
  /** Parent for the private temp directory used while verifying a received artifact. */
  artifactRoot?: string;
  /** Must obtain explicit host-qualified user consent; never takes a remote path. */
  chooseUpload?: (
    host: string,
    signal: AbortSignal,
  ) => Promise<{ source: ChosenUpload; mime: string } | undefined>;
}

/** Timers used by the heartbeat and the reconnect backoff. */
export interface ClientClock {
  now(): number;
  /** Runs `run` after `delayMs`; returns a cancel function. */
  setTimer(delayMs: number, run: () => void): () => void;
}

const systemClock: ClientClock = {
  now: () => Date.now(),
  setTimer(delayMs, run) {
    const timer = setTimeout(run, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** Half the owner's 6 s silence timeout. */
const HEARTBEAT_MS = 2_000;
/** Matches the owner's detach grace: after this the page is gone. */
const GRACE_MS = 10 * 60_000;
/** Time for ssh to forward the final stop frame before the lane is killed. */
const STOP_FLUSH_MS = 500;
/** Reconnect delays: 1 s, 2 s, then every 5 s until the grace expires. */
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000] as const;
/** Backstop for one request; the owner also bounds each tool by its own timeout. */
export const REQUEST_TIMEOUT_MS = 60_000;

/** Time for ssh to report the allocated forward port before the session gives up. */
const FORWARD_ALLOCATION_TIMEOUT_MS = 10_000;
/** Bounds the wait for ready; it starts before ssh connects, so it covers cold owner start too. */
const READY_TIMEOUT_MS = 60_000;

function retryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length - 1)];
}

export interface RemoteClient {
  /** Resolves with the exit code once the session ends. */
  run(): Promise<number>;
  /** One tool call, or `status` for the pane state, over the attached control lane. */
  call(tool: string, params: JsonValue, timeoutMs?: number): Promise<JsonValue>;
  /** A frozen capture of the remote page: offer, then verified bytes over the bulk lane. */
  capture(params: JsonValue, timeoutMs?: number): Promise<RemoteCapture>;
}

import { parseCaptureProvenance } from './captureProvenance';

export interface RemoteCapture {
  provenance?: import('./captureProvenance').CaptureProvenance;
  png: Buffer;
  url: string;
  inputWidth?: number;
  inputHeight?: number;
}

const CAPTURE_NAME = 'capture.png';
const MAX_URL_LENGTH = 2048;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** A capture reply is an artifact offer plus the bulk read token and page state. */
interface CaptureReply {
  provenance?: import('./captureProvenance').CaptureProvenance;
  offer: ArtifactOffer;
  token: string;
  url: string;
  inputWidth?: number;
  inputHeight?: number;
}

/** The local capture path persists any page url, including about:blank and data: pages. */
function isPageUrl(value: string): boolean {
  return value.length >= 1 && value.length <= MAX_URL_LENGTH;
}

function dimension(value: JsonValue | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) return undefined;
  return value;
}

/** Parses the owner's capture result; every field is untrusted. */
function captureReply(value: JsonValue): CaptureReply {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid capture reply');
  const record = value as Record<string, JsonValue>;
  const offer = parseArtifactOffer({
    id: record.id,
    name: record.name,
    mime: record.mime,
    size: record.size,
    sha256: record.sha256,
  });
  if (offer.mime !== 'image/png' || offer.name !== CAPTURE_NAME)
    throw new Error('Invalid capture reply');
  const token = record.token;
  const url = record.url;
  if (
    typeof token !== 'string' ||
    !ID_PATTERN.test(token) ||
    typeof url !== 'string' ||
    !isPageUrl(url)
  )
    throw new Error('Invalid capture reply');
  const provenance = parseCaptureProvenance(record.provenance);
  const inputWidth = dimension(record.inputWidth);
  const inputHeight = dimension(record.inputHeight);
  return {
    offer,
    token,
    url,
    ...(provenance ? { provenance } : {}),
    ...(inputWidth !== undefined ? { inputWidth } : {}),
    ...(inputHeight !== undefined ? { inputHeight } : {}),
  };
}

interface PendingRequest {
  resolve: (value: JsonValue) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MODIFIERS: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'meta'];
const BUTTONS: readonly PointerButton[] = ['left', 'middle', 'right'];
const TEXT_LIMIT = 1024;

function modifierList(event: NonNullable<TermEvent['keyEvent']>): Modifier[] {
  return MODIFIERS.filter((modifier) => event.modifiers.includes(modifier));
}

/** One terminal event as the wire input event; undefined when it has no remote meaning. */
function toInput(event: TermEvent): InputEvent | undefined {
  if (event.eventType === 'key') {
    const key = event.keyEvent;
    if (!key || key.code.length < 1 || key.code.length > 64) return undefined;
    const modifiers = modifierList(key);
    return {
      kind: 'key',
      key: key.code,
      ...(modifiers.length ? { modifiers } : {}),
      ...(key.down ? {} : { up: true as const }),
    };
  }
  if (event.eventType === 'paste') {
    const text = event.paste ?? '';
    return text.length ? { kind: 'text', text } : undefined;
  }
  if (event.eventType === 'mouse') {
    const mouse = event.mouseEvent;
    if (!mouse) return undefined;
    if (mouse.kind === 'mouseMove')
      return { kind: 'pointer', action: 'move', x: mouse.x, y: mouse.y };
    if (mouse.kind === 'mouseDown' || mouse.kind === 'mouseUp') {
      const button = BUTTONS.find((candidate) => candidate === mouse.button);
      return button
        ? {
            kind: 'pointer',
            action: mouse.kind === 'mouseDown' ? 'down' : 'up',
            x: mouse.x,
            y: mouse.y,
            button,
          }
        : undefined;
    }
    const dx = mouse.kind === 'scrollLeft' ? -1 : mouse.kind === 'scrollRight' ? 1 : 0;
    const dy = mouse.kind === 'scrollUp' ? -1 : mouse.kind === 'scrollDown' ? 1 : 0;
    return { kind: 'wheel', x: mouse.x, y: mouse.y, dx, dy };
  }
  return undefined;
}

function textChunks(text: string): string[] {
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += TEXT_LIMIT)
    chunks.push(text.slice(offset, offset + TEXT_LIMIT));
  return chunks;
}

/**
 * Local half of a remote pane: it opens the control and media ssh lanes, runs the
 * auth handshake, paints owner PNGs in the current terminal, forwards input and
 * stops both lanes on exit. A lost lane keeps the last image and reattaches until
 * the owner's detach grace runs out. The terminal is set up and restored here, so
 * a failure leaves no half-configured screen.
 */
export function createRemoteClient(deps: RemoteClientDeps): RemoteClient {
  const { terminal } = deps;
  const clock = deps.clock ?? systemClock;
  const laneArgv = (channel: 'control' | 'media' | 'bulk', forward?: RemoteForward) => [
    ...sshArgv(deps.alias, channel, deps.runtimePath, forward),
    ...(deps.android !== undefined ? ['--kind', 'android'] : []),
  ];
  let request = randomBytes(8).toString('hex');
  let controlDecoder = new FrameDecoder();
  let mediaDecoder = new MediaDecoder();
  let control: RemoteLane | undefined;
  let media: RemoteLane | undefined;
  let renderer: RemoteRenderer | undefined;
  let stopInput: (() => void) | undefined;
  let stopResize: (() => void) | undefined;
  let settle: ((code: number) => void) | undefined;
  let finished = false;
  /** Only a completed handshake accepts input, credit or heartbeats. */
  let connected = false;
  let externalNoticed = false;
  let fileChooserNoticed = false;
  let copyUntil: number | undefined;
  let session: string | undefined;
  let generation = 0;
  let epoch = 0;
  let seq = 0;
  /** Bumped per lane set, so late events from a replaced lane are ignored. */
  let laneToken = 0;
  /** Remote loopback port sshd allocated for this control lane's forward. */
  let forwardRemotePort: number | undefined;
  /** Detaches the stderr scanner and cancels its allocation timeout. */
  let handshakeCleanup: (() => void) | undefined;
  let heartbeatCancel: (() => void) | undefined;
  let retryCancel: (() => void) | undefined;
  let reconnecting = false;
  let attempt = 0;
  let deadline = 0;
  let pendingMove: InputEvent | undefined;
  let moveTimer: ReturnType<typeof setTimeout> | undefined;
  /** Tool requests waiting for the owner's result; never replayed across a reconnect. */
  const pending = new Map<string, PendingRequest>();
  let nextRequest = 0;

  /** Connection state in the window title; the remote view has no toolbar. */
  function status(state: 'Connecting' | 'Attached' | 'Disconnected, reconnecting'): void {
    terminal.output.setTitle(`${deps.alias} · ${state} · awrit`);
  }

  function write(message: ControlMessage) {
    if (finished || !control) return;
    control.stdin.write(encodeFrame('control', Buffer.from(JSON.stringify(message))));
  }

  function stopHeartbeat(): void {
    heartbeatCancel?.();
    heartbeatCancel = undefined;
  }

  /** A missed 2 s beat would start the owner's silence timeout. */
  function beat(): void {
    heartbeatCancel = undefined;
    if (finished || !connected) return;
    write({ type: 'heartbeat' });
    heartbeatCancel = clock.setTimer(HEARTBEAT_MS, beat);
  }

  function sendViewport() {
    const size = deps.size();
    write({
      type: 'viewport',
      epoch,
      width: size.width,
      height: size.height,
      cols: size.cols,
      rows: size.rows,
    });
  }

  function sendInput(event: InputEvent) {
    if (!connected) return;
    write({ type: 'input', seq: seq++, generation, epoch, event });
  }

  function flushMove() {
    moveTimer = undefined;
    const event = pendingMove;
    pendingMove = undefined;
    if (event) sendInput(event);
  }

  /** Pointer moves coalesce per tick; everything else keeps its order. */
  function queueInput(event: InputEvent) {
    if (event.kind === 'pointer' && event.action === 'move') {
      pendingMove = event;
      if (moveTimer === undefined) moveTimer = setTimeout(flushMove, 0);
      return;
    }
    if (moveTimer !== undefined) {
      clearTimeout(moveTimer);
      flushMove();
    }
    sendInput(event);
  }

  function failPending(reason: string) {
    const entries = [...pending.values()];
    pending.clear();
    for (const entry of entries) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
  }

  /** One tool call on the control lane; the owner answers `result` or `error` for the same id. */
  function call(
    tool: string,
    params: JsonValue,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<JsonValue> {
    return new Promise((resolve, reject) => {
      if (finished || !connected || !control) {
        reject(new Error('Remote session is not attached'));
        return;
      }
      if (!tool.length || tool.length > 64) {
        reject(new Error('Invalid tool name'));
        return;
      }
      const id = `r${++nextRequest}`;
      const timer = setTimeout(
        () => {
          pending.delete(id);
          reject(new Error('Remote request timed out'));
        },
        Math.min(Math.max(1, timeoutMs), REQUEST_TIMEOUT_MS),
      );
      timer.unref();
      pending.set(id, { resolve, reject, timer });
      write({ type: 'request', request: id, tool, params });
    });
  }

  /** One transfer at a time; a second read waits for the caller to retry. */
  let bulkActive = false;
  type PendingUpload = {
    id: string;
    controller: AbortController;
    phase: 'selecting' | 'offered' | 'writing' | 'written';
    source?: ChosenUpload;
    cancelTimer: () => void;
    complete: boolean;
  };
  let upload: PendingUpload | undefined;

  function cancelUpload(notifyOwner = false) {
    const current = upload;
    if (!current) return;
    upload = undefined;
    current.cancelTimer();
    current.controller.abort();
    if (notifyOwner && connected) write({ type: 'upload-cancel', chooser: current.id });
    if (current.source && current.phase !== 'writing')
      void current.source.close().catch((error) => deps.stderr(String(error)));
    bulkActive = false;
  }

  async function selectUpload(id: string) {
    if (!deps.chooseUpload || upload || bulkActive) {
      write({ type: 'upload-cancel', chooser: id });
      return;
    }
    bulkActive = true;
    const current: PendingUpload = {
      id,
      controller: new AbortController(),
      phase: 'selecting',
      complete: false,
      cancelTimer: () => {},
    };
    upload = current;
    try {
      const chosen = await deps.chooseUpload(deps.alias, current.controller.signal);
      if (upload !== current || current.controller.signal.aborted) {
        await chosen?.source.close();
        return;
      }
      if (!chosen) {
        cancelUpload(true);
        return;
      }
      current.source = chosen.source;
      // The deadline guards the transfer, not the human browsing the native dialog.
      current.cancelTimer = clock.setTimer(120000, () => cancelUpload(true));
      const offer = parseArtifactOffer({
        id: randomBytes(16).toString('hex'),
        ...chosen.source.metadata,
        mime: chosen.mime,
      });
      current.phase = 'offered';
      write({ type: 'upload-offer', chooser: id, offer });
    } catch (error) {
      if (upload === current) {
        deps.stderr(`Upload failed: ${String(error)}`);
        cancelUpload(true);
      }
    }
  }

  async function sendUpload(chooser: string, token: string) {
    const current = upload;
    if (!current || current.id !== chooser || current.phase !== 'offered' || !current.source)
      return;
    current.phase = 'writing';
    // Idle deadline: restarts on every chunk, so slow but live uploads finish.
    const armIdle = () => {
      current.cancelTimer();
      current.cancelTimer = clock.setTimer(120000, () => {
        if (upload === current) cancelUpload(true);
      });
    };
    armIdle();
    const source = current.source;
    try {
      await writeUpload(
        deps.spawn(laneArgv('bulk')),
        chooser,
        token,
        touching(source.chunks(), armIdle),
        current.controller.signal,
      );
      current.phase = 'written';
      if (current.complete && upload === current) {
        current.source = undefined;
        cancelUpload();
      }
    } catch (error) {
      if (upload === current) {
        deps.stderr(`Upload failed: ${String(error)}`);
        cancelUpload(true);
      }
    } finally {
      current.source = undefined;
      try {
        await source.close();
      } catch (error) {
        deps.stderr(`Upload cleanup failed: ${String(error)}`);
      }
    }
  }

  /** Reads the offered capture once over a fresh bulk lane and verifies its bytes. */
  async function readArtifact(reply: CaptureReply, timeoutMs: number): Promise<Buffer> {
    if (bulkActive) throw new Error('Another remote file transfer is running');
    bulkActive = true;
    let dir: string | undefined;
    let lane: RemoteLane | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      dir = await fs.mkdtemp(path.join(deps.artifactRoot ?? os.tmpdir(), 'awrit-artifact-'));
      const current = deps.spawn(laneArgv('bulk'));
      lane = current;
      current.onClose((failure) => {
        // Ending the stream lets the hash/size check fail instead of hanging.
        if (failure) current.stdout.destroy(new Error(failure));
      });
      current.stdin.on('error', () => undefined);
      current.stdin.write(
        encodeFrame(
          'control',
          Buffer.from(
            JSON.stringify({
              type: 'artifact',
              artifact: reply.offer.id,
              action: 'read',
              token: reply.token,
            }),
          ),
        ),
      );
      // Keep stdin open: ending it makes the bridge close the lane before the
      // owner's reply arrives. The owner closes the lane after sending.
      // A stalled ssh must not hold the transfer slot or the command open.
      const timeout = new Promise<never>((_, reject) => {
        const limit = Math.min(Math.max(1, timeoutMs), REQUEST_TIMEOUT_MS);
        timer = setTimeout(() => reject(new Error('Remote file transfer timed out')), limit);
        timer.unref();
      });
      const file = await Promise.race([receiveArtifact(reply.offer, current.stdout, dir), timeout]);
      return await fs.readFile(file);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      // Stop a lane still streaming into a reader that already gave up.
      lane?.stdout.destroy();
      lane?.stdin.destroy();
      lane?.kill();
      bulkActive = false;
      if (dir) await fs.rm(dir, { recursive: true, force: true });
    }
  }

  async function capture(
    params: JsonValue,
    timeoutMs = REQUEST_TIMEOUT_MS,
  ): Promise<RemoteCapture> {
    const reply = captureReply(await call('capture', params, timeoutMs));
    const png = await readArtifact(reply, timeoutMs);
    return {
      png,
      url: reply.url,
      ...(reply.provenance ? { provenance: reply.provenance } : {}),
      ...(reply.inputWidth !== undefined ? { inputWidth: reply.inputWidth } : {}),
      ...(reply.inputHeight !== undefined ? { inputHeight: reply.inputHeight } : {}),
    };
  }

  function fail(message: string) {
    finish(1, `${deps.alias}: ${message}`);
  }

  /** `detach` keeps the remote page for its grace so the user can reattach. */
  function finish(code: number, line?: string, end: 'stop' | 'detach' = 'stop') {
    if (finished) return;
    finished = true;
    copyUntil = undefined;
    // Remote text is untrusted: drop control characters so it cannot drive the terminal.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal controls
    if (line !== undefined) deps.stderr(line.replace(/[\u0000-\u001f\u007f-\u009f]/g, ''));
    stopInput?.();
    stopResize?.();
    stopHeartbeat();
    clearHandshakeWait();
    retryCancel?.();
    retryCancel = undefined;
    if (moveTimer !== undefined) clearTimeout(moveTimer);
    moveTimer = undefined;
    pendingMove = undefined;
    cancelUpload();
    failPending('Remote session ended');
    if (control) {
      // Written directly: finish() has set the flag that write() checks. A stop
      // only makes sense on a connected session; a lost one is already detached.
      if (connected)
        control.stdin.write(
          encodeFrame(
            'control',
            Buffer.from(
              JSON.stringify(end === 'stop' ? { type: 'stop', request } : { type: 'detach' }),
            ),
          ),
        );
      try {
        control.stdin.end();
      } catch {}
      // Killing at once can drop the stop frame and leave the page for the full
      // grace; give ssh a moment to flush, then make sure it is gone.
      const dying = control;
      if (connected) clock.setTimer(STOP_FLUSH_MS, () => dying.kill());
      else dying.kill();
    }
    media?.kill();
    connected = false;
    renderer?.dispose();
    terminal.output.cleanup();
    settle?.(code);
  }

  function onControlChunk(token: number, chunk: Buffer) {
    if (token !== laneToken) return;
    try {
      for (const frame of controlDecoder.push(chunk)) {
        if (frame.kind !== 'control') throw new Error('unexpected owner output');
        handle(parseControl(JSON.parse(frame.payload.toString('utf8'))));
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  function onMediaChunk(token: number, chunk: Buffer) {
    if (token !== laneToken) return;
    try {
      if (!renderer) throw new Error('media arrived before the session was ready');
      for (const frame of mediaDecoder.push(chunk)) {
        if (frame.meta.epoch !== epoch) {
          // The frame was never painted, so its credit slot is free again.
          write({ type: 'credit', surface: frame.meta.surface });
          continue;
        }
        renderer.render(frame);
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
  }

  function handle(message: ControlMessage) {
    if (message.type === 'external-link') {
      if (connected && !externalNoticed) {
        externalNoticed = true;
        deps.notify?.(
          `${deps.alias} requested a local browser: ${message.url} (automatic opening unsupported; open only if trusted)`,
        );
      }
      return;
    }
    if (message.type === 'upload-cancel' && upload?.id === message.chooser) {
      cancelUpload();
      return;
    }
    if (message.type === 'upload-grant' && connected) {
      void sendUpload(message.chooser, message.token);
      return;
    }
    if (message.type === 'upload-complete' && upload?.id === message.chooser) {
      upload.complete = true;
      if (upload.phase === 'written') cancelUpload();
      return;
    }
    if (message.type === 'file-chooser' && connected) {
      void selectUpload(message.chooser);
      if (deps.chooseUpload) return;
    }
    if (message.type === 'file-chooser-unsupported' || message.type === 'file-chooser') {
      if (connected && !fileChooserNoticed) {
        fileChooserNoticed = true;
        deps.notify?.(
          `${deps.alias}: local file selection and upload are unsupported in this remote viewer; no host file dialog was opened.`,
        );
      }
      return;
    }
    if (message.type === 'clipboard') {
      const allowed = connected && copyUntil !== undefined && clock.now() < copyUntil;
      copyUntil = undefined;
      if (allowed) deps.writeClipboard?.(message.text);
      return;
    }
    if (message.type === 'result') {
      const waiting = pending.get(message.request);
      if (!waiting) return;
      pending.delete(message.request);
      clearTimeout(waiting.timer);
      waiting.resolve(message.value);
      return;
    }
    if (message.type === 'error') {
      const waiting = message.request ? pending.get(message.request) : undefined;
      if (waiting && message.request) {
        pending.delete(message.request);
        clearTimeout(waiting.timer);
        waiting.reject(new Error(message.message));
        return;
      }
      // Until the owner notices the lost lane (up to 6 s) it still holds the
      // lease, so busy during a reconnect means try again. Anything else is final.
      if (message.code === 'busy' && reconnecting && !finished) {
        dropLanes();
        scheduleRetry();
        return;
      }
      fail(message.message);
      return;
    }
    if (message.type !== 'ready' || finished) return;
    if (message.request !== request) {
      fail('unexpected remote response');
      return;
    }
    const wanted = session ?? deps.session;
    if (wanted !== undefined && message.session !== wanted) {
      fail('unexpected remote response');
      return;
    }
    if (connected) return;
    clearHandshakeWait();
    session = message.session;
    generation = message.generation;
    seq = 0;
    connected = true;
    externalNoticed = false;
    fileChooserNoticed = false;
    reconnecting = false;
    status('Attached');
    renderer?.shade(undefined);
    deps.onReady?.(message.session);
    attempt = 0;
    retryCancel?.();
    retryCancel = undefined;
    const token = laneToken;
    renderer ??= createRemoteRenderer({
      terminal,
      epoch: () => epoch,
      credit: (surface) => write({ type: 'credit', surface }),
    });
    // The same epoch keeps the terminal placement; the owner repaints on resize.
    sendViewport();
    stopHeartbeat();
    heartbeatCancel = clock.setTimer(HEARTBEAT_MS, beat);
    openMedia(message.token, token);
  }

  function openMedia(token: string, lane: number): void {
    try {
      const next = deps.spawn(laneArgv('media'));
      media = next;
      next.onClose((failure) => {
        if (finished || lane !== laneToken) return;
        laneLost(failure);
      });
      next.stdout.on('data', (chunk: Buffer) => onMediaChunk(lane, chunk));
      // The token is the only frame on this lane and is never logged or in argv.
      next.stdin.write(
        encodeFrame('control', Buffer.from(JSON.stringify({ type: 'media', token }))),
      );
    } catch (error) {
      laneLost(error instanceof Error ? error.message : String(error));
    }
  }

  function dropLanes(): void {
    copyUntil = undefined;
    laneToken += 1;
    connected = false;
    stopHeartbeat();
    clearHandshakeWait();
    cancelUpload();
    failPending('Remote connection lost');
    const dyingControl = control;
    const dyingMedia = media;
    control = undefined;
    media = undefined;
    if (dyingControl) {
      try {
        dyingControl.stdin.end();
      } catch {}
      dyingControl.kill();
    }
    dyingMedia?.kill();
  }

  function scheduleRetry(): void {
    if (finished || retryCancel) return;
    const wait = Math.min(retryDelay(attempt), deadline - clock.now());
    attempt += 1;
    retryCancel = clock.setTimer(Math.max(wait, 0), () => {
      retryCancel = undefined;
      retry();
    });
  }

  function retry(): void {
    if (finished) return;
    if (clock.now() >= deadline) {
      fail('remote session lost');
      return;
    }
    // This attempt replaces the last one even if its ssh never exited.
    dropLanes();
    openControl(false);
    // Armed while the attempt runs: a silent owner must not stall the grace.
    scheduleRetry();
  }

  /**
   * A lane died. Before the first ready there is nothing to reattach to; after
   * it, keep the last image and reconnect until the owner's grace runs out.
   */
  /** Dims the last frame so a lost connection never looks live. */
  function shadeStale(): void {
    const { cols, rows } = deps.size();
    renderer?.shade({ cols, rows });
  }

  function laneLost(failure?: string): void {
    if (finished) return;
    if (session === undefined) {
      fail(failure ?? 'remote connection closed');
      return;
    }
    dropLanes();
    if (!reconnecting) {
      reconnecting = true;
      status('Disconnected, reconnecting');
      shadeStale();
      attempt = 0;
      deadline = clock.now() + GRACE_MS;
    }
    scheduleRetry();
  }

  function clearHandshakeWait() {
    handshakeCleanup?.();
    handshakeCleanup = undefined;
  }

  /** Sends hello, then create for a new page or attach to the existing session. */
  function beginSession(lane: RemoteLane, token: number, allocated?: number) {
    if (finished || token !== laneToken || control !== lane) return;
    write({ type: 'hello', version: 1, build: deps.build ?? 'awrit', codecs: ['png'] });
    if (session === undefined && deps.session !== undefined)
      write({ type: 'attach', request, session: deps.session });
    else if (session === undefined) {
      // A forwarded page keeps its scheme, path, query and hash on the allocated port.
      const url = allocated === undefined ? deps.url : forwardedUrl(deps.url, allocated);
      if (deps.android !== undefined)
        write({ type: 'create-android', request, device: deps.android, url });
      else write({ type: 'create', request, url });
    } else write({ type: 'attach', request, session });
    clearHandshakeWait();
    handshakeCleanup = clock.setTimer(READY_TIMEOUT_MS, () => {
      if (finished || token !== laneToken || connected) return;
      laneLost('remote owner did not respond');
    });
  }

  function openControl(initial: boolean): void {
    const token = ++laneToken;
    controlDecoder = new FrameDecoder();
    mediaDecoder = new MediaDecoder();
    request = randomBytes(8).toString('hex');
    const localPort = deps.forward;
    // The first lane asks sshd to allocate a port; a reattach keeps that same
    // port, because the page still points at the effective URL.
    const allocated = forwardRemotePort;
    let lane: RemoteLane;
    try {
      lane = deps.spawn(
        laneArgv(
          'control',
          localPort === undefined ? undefined : { localPort, remotePort: allocated ?? 0 },
        ),
      );
    } catch (error) {
      if (initial) fail(error instanceof Error ? error.message : String(error));
      else scheduleRetry();
      return;
    }
    control = lane;
    lane.onClose((failure) => {
      if (finished || token !== laneToken) return;
      laneLost(failure);
    });
    lane.stdout.on('data', (chunk: Buffer) => onControlChunk(token, chunk));
    if (localPort === undefined || allocated !== undefined) {
      beginSession(lane, token, allocated);
      return;
    }
    if (!lane.stderr) {
      fail('ssh did not provide the stderr needed for the forwarded port');
      return;
    }
    const scanner = createForwardPortScanner(localPort);
    const onStderr = (chunk: string | Buffer) => {
      if (finished || token !== laneToken) return;
      const port = scanner.push(chunk);
      if (port === undefined) return;
      forwardRemotePort = port;
      clearHandshakeWait();
      // Reported before the page loads, so the effective URL is not a surprise.
      deps.stderr(`${deps.alias}: ${forwardedUrl(deps.url, port)}`);
      beginSession(lane, token, port);
    };
    lane.stderr.on('data', onStderr);
    const cancelTimer = clock.setTimer(FORWARD_ALLOCATION_TIMEOUT_MS, () => {
      clearHandshakeWait();
      if (finished || token !== laneToken) return;
      // ExitOnForwardFailure closes ssh on a setup failure; this bounds silence.
      fail('ssh did not report the forwarded port');
    });
    handshakeCleanup = () => {
      cancelTimer();
      lane.stderr?.off('data', onStderr);
    };
  }

  function onEvent(event: TermEvent) {
    if (finished) return;
    if (event.eventType === 'graphics') {
      renderer?.acknowledge(event.graphics?.id ?? '');
      return;
    }
    if (event.eventType === 'resize') {
      if (connected) {
        epoch += 1;
        sendViewport();
      }
      return;
    }
    const key = event.eventType === 'key' ? event.keyEvent : undefined;
    const copying =
      key?.code.toLowerCase() === 'c' &&
      key.down &&
      ((key.modifiers.length === 1 && key.modifiers.includes('meta')) ||
        (key.modifiers.length === 2 &&
          key.modifiers.includes('ctrl') &&
          key.modifiers.includes('shift')));
    if (key?.code === 'c' && key.down && key.modifiers.includes('ctrl') && !copying) {
      finish(0);
      return;
    }
    if (
      key?.code === 'd' &&
      key.down &&
      key.modifiers.length === 1 &&
      key.modifiers[0] === 'ctrl'
    ) {
      const kept = session;
      // A new process cannot get the same sshd-allocated port back, so a
      // forwarded page would be kept pointing at a dead port: stop it instead.
      if (!connected || kept === undefined || deps.forward !== undefined) return finish(0);
      finish(
        0,
        deps.android !== undefined
          ? `Disconnected; the device stream stays on ${deps.alias} for 10 minutes. Reattach: awrit device view ${deps.android} --host ${deps.alias} --remote-awrit ${deps.runtimePath} --session ${kept}`
          : `Disconnected; the page stays on ${deps.alias} for 10 minutes. Reattach: awrit show ${deps.url} --host ${deps.alias} --session ${kept}`,
        'detach',
      );
      return;
    }
    // Input while disconnected is dropped: the controller lease is gone.
    if (!connected) return;
    const input = toInput(event);
    if (!input) return;
    if (copying) copyUntil = clock.now() + 2_000;
    if (input.kind === 'text') {
      for (const text of textChunks(input.text)) queueInput({ kind: 'text', text });
      return;
    }
    queueInput(input);
  }

  async function run(): Promise<number> {
    const done = new Promise<number>((resolve) => {
      settle = resolve;
    });
    try {
      terminal.output.setup();
      stopInput = deps.input(onEvent);
      stopResize = deps.onResize(() => {
        if (reconnecting && !finished) shadeStale();
        if (!connected || finished) return;
        epoch += 1;
        sendViewport();
      });
      status('Connecting');
      openControl(true);
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error));
    }
    return done;
  }

  return { run, call, capture };
}

const REMOTE_SETTINGS: PaneSettings = {
  overlay: false,
  design: false,
  transparent: false,
  noPaint: false,
  debugPaint: false,
};

function spawnSshLane(argv: string[]): RemoteLane {
  const child = spawn('ssh', argv, { stdio: ['pipe', 'pipe', 'pipe'] });
  relayRemoteStderr(child.stderr);
  if (!child.stdin || !child.stdout || !child.stderr)
    throw new Error('ssh did not provide stdio pipes');
  // A stop frame may race a dying ssh; the close handler already reports it.
  child.stdin.on('error', () => undefined);
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    onClose: (listener) => {
      let closed = false;
      const once = (failure?: string) => {
        if (closed) return;
        closed = true;
        listener(failure);
      };
      child.once('error', (error) => once(error.message));
      child.once('close', (code) => once(code ? `ssh exited with code ${code}` : undefined));
    },
    kill: () => {
      child.kill('SIGTERM');
    },
  };
}

export interface RemoteShowOptions {
  alias: string;
  url: string;
  /** Remote Android device; changes only creation, not transport or rendering. */
  android?: string;
  runtimePath: string;
  /** Local loopback port the remote host may reach, with the user's consent. */
  forward?: number;
  session?: string;
}

/** `awrit show <url> --host <alias>`: draw one remote page in this terminal. */
export async function runRemoteShow(options: RemoteShowOptions): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error('Awrit remote view needs an interactive terminal.');
  const { getWindowSize, listenForInput, termDisableFeatures, termEnableFeatures } = await import(
    'awrit-native-rs'
  );
  const features = termEnableFeatures();
  try {
    if (!features.keyboard || !features.images)
      throw new Error(
        'This terminal lacks Kitty keyboard and graphics support. Run awrit in Kitty.',
      );
    const terminal = createTerminalContext(
      'remote',
      getWindowSize(),
      features,
      (data) => {
        process.stdout.write(data);
      },
      REMOTE_SETTINGS,
    );
    // Same neighbour resolution as the local viewer: local-only, never on the wire.
    let sourceWindowId = process.env.AWRIT_SOURCE_WINDOW_ID;
    if (!sourceWindowId && process.env.KITTY_WINDOW_ID) {
      try {
        const { findKittyNeighborWindowId } = await import('../presentation/kittyDiscovery');
        sourceWindowId = await findKittyNeighborWindowId(process.env.KITTY_WINDOW_ID);
      } catch {}
    }
    let pane: RemotePaneServer | undefined;
    let starting: string | undefined;
    let stopping = false;
    const forward = async (
      type: RemoteRequestType,
      payload: Record<string, unknown>,
    ): Promise<unknown> => {
      // `awrit status` waits 2 s; a longer cap would leave the request pending.
      if (type === 'viewer:status') return await client.call('status', {}, 2_000);
      if (type === 'tools:list') return await client.call('list', {});
      if (type === 'capture:request') {
        const shot = await client.capture(payload as JsonValue);
        return {
          base64: shot.png.toString('base64'),
          url: shot.url,
          ...(shot.provenance ? { provenance: shot.provenance } : {}),
          ...(shot.inputWidth !== undefined ? { inputWidth: shot.inputWidth } : {}),
          ...(shot.inputHeight !== undefined ? { inputHeight: shot.inputHeight } : {}),
        };
      }
      return client.call(String(payload.name), (payload.arguments ?? {}) as JsonValue);
    };
    const chooseUpload = createUploadChooser(process.env);
    const client: RemoteClient = createRemoteClient({
      ...options,
      ...(chooseUpload ? { chooseUpload } : {}),
      terminal,
      size: () => getWindowSize(),
      spawn: spawnSshLane,
      input: (handler) => listenForInput(handler),
      onResize: (handler) => {
        process.on('SIGWINCH', handler);
        return () => {
          process.off('SIGWINCH', handler);
        };
      },
      writeClipboard: (text) => terminal.output.writeToTerminalClipboard(text),
      notify: (message) => {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: host text must not drive the terminal
        process.stderr.write(`${message.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')}\n`);
      },
      stderr: (line) => {
        process.stderr.write(`${line}\n`);
      },
      onReady: (session) => {
        if (pane?.session === session || starting === session) return;
        starting = session;
        startRemotePane({
          session,
          host: options.alias,
          ...(sourceWindowId ? { sourceWindowId } : {}),
          forward,
        })
          .then((server) => {
            if (stopping || starting !== session) {
              server.stop();
              return;
            }
            pane?.stop();
            pane = server;
          })
          .catch((error: unknown) => {
            const reason = error instanceof Error ? error.message : String(error);
            process.stderr.write(`awrit: cannot publish this remote viewer: ${reason}\n`);
          })
          .finally(() => {
            if (starting === session) starting = undefined;
          });
      },
    });
    try {
      return await client.run();
    } finally {
      stopping = true;
      pane?.stop();
    }
  } finally {
    termDisableFeatures(features);
  }
}
