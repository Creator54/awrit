import { createHash, randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import { PassThrough } from 'node:stream';
import type { TermEvent } from 'awrit-native-rs';
import { ownerBuildIdentity } from '../browserOwner/build';
import { capturePagePng } from '../browserOwner/pageCapture';
import { encodeFrame, FrameDecoder } from '../browserOwner/protocol';
import type { InitialFrame } from '../tty/kittyGraphics';
import type { WindowView } from '../windows';
import { MAX_ARTIFACT_BYTES } from './artifacts';
import { requestRemoteFile } from './fileChooser';
import {
  createFrameSink,
  type FrameEncoder,
  type FrameSink,
  type FrameSinkClock,
  systemClock,
} from './frameSink';
import {
  type ControlMessage,
  encodeMediaEnvelope,
  externalUrl,
  type InputEvent,
  type JsonValue,
  LIMITS,
  type MediaFrame,
  parseControl,
  toJson,
} from './protocol';
import { createSessionRegistry, type SessionPane } from './session';
import { pidAlive, startSupervisor, supervisorDir } from './supervisor';
import { createUploadReceiver, type RetainedUpload, sweepStaleUploads } from './uploadReceiver';
import { touching } from './uploadSource';

export type Viewport = Extract<ControlMessage, { type: 'viewport' }>;
export type Ready = Extract<ControlMessage, { type: 'ready' }>;

/** A page screenshot the remote owner can export over the bulk lane. */
export interface PaneCapture {
  png: Buffer;
  url: string;
  inputWidth: number;
  inputHeight: number;
}

export interface CaptureOptions {
  waitMs?: number;
  waitSelector?: string;
}

export interface PaneStatus {
  /** Retained for existing browser and Android URL consumers. */
  url: string;
  loading: boolean;
  target?: {
    kind: 'web' | 'android';
    state: 'starting' | 'ready' | 'closed';
    capabilities: {
      capture: boolean;
      tools: boolean;
      input: readonly ('key' | 'text' | 'pointer' | 'wheel')[];
    };
  };
}

/** An environment pane the owner drives. */
export interface RemotePane extends SessionPane {
  /** Device startup completes before `ready`; browser panes are synchronous. */
  ready?: Promise<void>;
  resize(viewport: Viewport): void;
  /** One browser tool call; a missing implementation answers `error`. */
  callTool?(name: string, params: JsonValue): Promise<JsonValue>;
  /** Current page state for `awrit status`. */
  status?(): Promise<PaneStatus>;
  /** Tool metadata for `awrit tool list`. */
  listTools?(): JsonValue;
  /** Captures the visible page; a missing implementation answers `error`. */
  capture?(options: CaptureOptions): Promise<PaneCapture>;
}

export interface PendingFileChooser {
  signal: AbortSignal;
  install(file: string): Promise<void>;
  cancel(): void;
}

export interface OwnerDeps {
  /** Android owners accept only create-android; browser owners only create. */
  android?: boolean;
  openPane: (
    url: string,
    id: string,
    sink: FrameSink,
    onClipboard: (text: string) => void,
    /** A page asked for the user's local browser; only shown when attached. */
    onExternal?: (url: string) => void,
    /** A page opened a file chooser; only reported when attached. */
    onFileChooserUnsupported?: () => void,
    onFileChooser?: (chooser: PendingFileChooser) => void,
  ) => RemotePane;
  now?: () => number;
  /** One-use media token; tests inject a deterministic generator. */
  token?: () => string;
  encode?: FrameEncoder;
  clock?: FrameSinkClock;
  onError?: (error: unknown) => void;
  /** Runs once no session has existed for `IDLE_MS`, so stale builds do not linger. */
  onIdle?: () => void;
}

export interface OwnerChannels {
  sendControl(message: ControlMessage): void;
  /** One complete `encodeMediaEnvelope` result. */
  sendMedia(bytes: Buffer): void;
  close(): void;
}

export interface OwnerConnection {
  /** Feeds one decoded control frame; the first one picks the lane. */
  accept(message: ControlMessage): void;
  receiveUpload(chooser: string, token: string, chunks: AsyncIterable<Uint8Array>): Promise<void>;
  close(): void;
}

export interface Owner {
  connect(channels: OwnerChannels): OwnerConnection;
  /** Socket adapter: decodes control frames and serves one bridge connection. */
  handleConnection(socket: Socket): void;
}

interface SessionState {
  closed?: boolean;
  starting?: boolean;
  id: string;
  pane: RemotePane;
  sink: FrameSink;
  generation: number;
  epoch: number;
  media?: OwnerChannels;
  control?: OwnerChannels;
  /** Last applied viewport, replayed when a media lane binds. */
  viewport?: Viewport;
  /** Cancels the detach grace that stops this session; cleared on reattach. */
  graceCancel?: () => void;
  /** One capture waiting for a bulk read; bounded and replaced by the next capture. */
  artifact?: PendingArtifact;
  artifactCancel?: () => void;
  retainedUploads?: Set<{ size: number; dispose(): Promise<void> }>;
  upload?: {
    id: string;
    chooser: PendingFileChooser;
    controller: AbortController;
    /** Restarts the idle deadline; called for each received chunk. */
    touch(): void;
    dispose(): void;
    receiver?: ReturnType<typeof createUploadReceiver>;
  };
}

interface PendingArtifact {
  id: string;
  token: string;
  bytes: Buffer;
  url: string;
  inputWidth: number;
  inputHeight: number;
}

interface TokenEntry {
  session: string;
  generation: number;
}

const report = (error: unknown): void => {
  console.error('Remote owner:', error instanceof Error ? error.message : error);
};

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 1024);
}

async function paneTool(pane: RemotePane, name: string, params: JsonValue): Promise<unknown> {
  if (!pane.callTool) throw new Error('Tools are not available for this viewer');
  return pane.callTool(name, params);
}

async function paneList(pane: RemotePane): Promise<unknown> {
  if (!pane.listTools) throw new Error('Tools are not available for this viewer');
  return pane.listTools();
}

async function paneStatus(pane: RemotePane): Promise<unknown> {
  if (!pane.status) throw new Error('Status is not available for this viewer');
  return pane.status();
}

/** Capture options arrive from the client, so every field is bounded here. */
function captureOptions(params: JsonValue): CaptureOptions {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  const options: CaptureOptions = {};
  const waitMs = params.waitMs;
  if (waitMs !== undefined) {
    if (
      typeof waitMs !== 'number' ||
      !Number.isSafeInteger(waitMs) ||
      waitMs < 1 ||
      waitMs > 30_000
    )
      throw new Error('Invalid capture wait');
    options.waitMs = waitMs;
  }
  const waitSelector = params.waitSelector;
  if (waitSelector !== undefined) {
    if (typeof waitSelector !== 'string' || !waitSelector.trim() || waitSelector.length > 1024)
      throw new Error('Invalid capture selector');
    options.waitSelector = waitSelector;
  }
  return options;
}

async function paneCapture(pane: RemotePane, params: JsonValue): Promise<PaneCapture> {
  if (!pane.capture) throw new Error('Capture is not available for this viewer');
  return pane.capture(captureOptions(params));
}

function withTimeout<T>(run: () => Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Tool timed out')), timeoutMs);
    timer.unref?.();
    run().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Three missed 2 s client heartbeats. */
const HEARTBEAT_TIMEOUT_MS = 6_000;
/** A detached session is kept this long for a reattach before its page closes. */
const GRACE_MS = 10 * 60_000;
/** The client reads a capture at once; one never read must not pin its PNG. */
const ARTIFACT_TTL_MS = 60_000;
/** An owner with no session for this long quits; the next client starts a fresh one. */
const IDLE_MS = GRACE_MS;

/** Every control connection is the same controller; the lease is what excludes others. */
const CONTROLLER = 'remote';

/**
 * Server side of the remote protocol. A connection is classified by its first
 * control frame: `hello` starts the control lane, `media` binds the one-use
 * token from `ready` to the session's frame sink.
 */
export function createOwner(deps: OwnerDeps): Owner {
  const sessions = new Map<string, SessionState>();
  const tokens = new Map<string, TokenEntry>();
  const now = deps.now ?? Date.now;
  const clock = deps.clock ?? systemClock;
  const newToken = deps.token ?? (() => randomBytes(24).toString('base64url'));

  let idleCancel: (() => void) | undefined;
  function armIdle(): void {
    if (!deps.onIdle || sessions.size || idleCancel) return;
    const onIdle = deps.onIdle;
    idleCancel = clock.setTimer(IDLE_MS, () => {
      idleCancel = undefined;
      if (!sessions.size) onIdle();
    });
  }

  const registry = createSessionRegistry({
    now,
    createPane: (url, id) => {
      const sink = createFrameSink(
        (frame: MediaFrame) => {
          const target = sessions.get(id);
          // The sink is built before attach assigns a generation; stamp it here.
          if (target?.media) {
            target.media.sendMedia(
              encodeMediaEnvelope({ ...frame.meta, generation: target.generation }, frame.payload),
            );
          }
        },
        {
          session: id,
          ...(deps.encode ? { encode: deps.encode } : {}),
          clock,
          onError: deps.onError ?? report,
        },
      );
      const pane = deps.openPane(
        url,
        id,
        sink,
        (text) => {
          if (text && Buffer.byteLength(text, 'utf8') <= LIMITS.clipboard)
            sessions.get(id)?.control?.sendControl({ type: 'clipboard', text });
        },
        (value) => {
          let link: string;
          try {
            link = externalUrl(value);
          } catch {
            return;
          }
          // Only an attached session has a control lane; a detached page is silent.
          sessions.get(id)?.control?.sendControl({ type: 'external-link', url: link });
        },
        () => {
          // Only an attached session has a control lane; a detached page is silent.
          sessions.get(id)?.control?.sendControl({ type: 'file-chooser-unsupported' });
        },
        (chooser) => {
          const target = sessions.get(id);
          if (!target?.control || chooser.signal.aborted || target.upload) {
            chooser.cancel();
            return;
          }
          const controller = new AbortController();
          const uploadId = randomBytes(16).toString('hex');
          // A chunk can arrive after cancel; only the current upload may cancel or re-arm.
          const current = () => target.upload?.id === uploadId;
          const abort = () => {
            if (current()) cancelUpload(target);
          };
          chooser.signal.addEventListener('abort', abort, { once: true });
          let expire = clock.setTimer(ARTIFACT_TTL_MS, abort);
          target.upload = {
            id: uploadId,
            chooser,
            controller,
            touch: () => {
              if (!current()) return;
              expire();
              expire = clock.setTimer(ARTIFACT_TTL_MS, abort);
            },
            dispose: () => {
              expire();
              chooser.signal.removeEventListener('abort', abort);
            },
          };
          target.control.sendControl({ type: 'file-chooser', chooser: uploadId });
        },
      );
      sessions.set(id, { id, pane, sink, generation: 0, epoch: 0 });
      idleCancel?.();
      idleCancel = undefined;
      return pane;
    },
  });

  function retainUpload(state: SessionState, file: RetainedUpload, signal: AbortSignal): void {
    state.retainedUploads ??= new Set();
    const retained = state.retainedUploads;
    const entry = {
      size: file.size,
      async dispose() {
        signal.removeEventListener('abort', cleanup);
        await file.dispose();
        retained.delete(entry);
      },
    };
    const cleanup = () => {
      void entry.dispose().catch(deps.onError ?? report);
    };
    retained.add(entry);
    signal.addEventListener('abort', cleanup, { once: true });
    if (signal.aborted) cleanup();
  }

  function cancelUpload(state: SessionState): void {
    const upload = state.upload;
    if (!upload) return;
    state.upload = undefined;
    upload.dispose();
    upload.controller.abort();
    upload.chooser.cancel();
    state.control?.sendControl({ type: 'upload-cancel', chooser: upload.id });
  }

  function cancelGrace(state: SessionState): void {
    state.graceCancel?.();
    state.graceCancel = undefined;
  }

  function startGrace(state: SessionState): void {
    cancelGrace(state);
    const generation = state.generation;
    state.graceCancel = clock.setTimer(GRACE_MS, () => {
      state.graceCancel = undefined;
      // A reattach bumped the generation and cancelled this timer; this is the
      // backstop in case it did not.
      if (sessions.get(state.id) !== state || state.generation !== generation) return;
      stopSession(state.id);
    });
  }

  function stopSession(id: string): void {
    const state = sessions.get(id);
    if (!state || state.closed) return;
    state.closed = true;
    sessions.delete(id);
    cancelUpload(state);
    for (const retained of state.retainedUploads ?? []) {
      void retained.dispose().catch(deps.onError ?? report);
    }
    cancelGrace(state);
    state.artifactCancel?.();
    state.artifactCancel = undefined;
    const media = state.media;
    state.media = undefined;
    media?.close();
    for (const [token, entry] of tokens) if (entry.session === id) tokens.delete(token);
    state.sink.dispose();
    registry.stop(id);
    armIdle();
  }

  armIdle();

  /** Keeps one pending capture per session and answers with its read offer. */
  async function storeCapture(
    state: SessionState,
    pane: RemotePane,
    params: JsonValue,
  ): Promise<Record<string, unknown>> {
    const generation = state.generation;
    const epoch = state.epoch;
    const shot = await paneCapture(pane, params);
    // A late capture must not become evidence for a replacement attachment or viewport.
    if (
      state.closed ||
      sessions.get(state.id) !== state ||
      state.generation !== generation ||
      state.epoch !== epoch
    )
      throw new Error('Viewer changed during capture; capture again');
    if (!shot.png.byteLength || shot.png.byteLength > LIMITS.mediaPayload)
      throw new Error('Capture is too large');
    const id = randomBytes(9).toString('base64url');
    const token = newToken();
    state.artifactCancel?.();
    state.artifact = {
      id,
      token,
      bytes: shot.png,
      url: shot.url,
      inputWidth: shot.inputWidth,
      inputHeight: shot.inputHeight,
    };
    state.artifactCancel = clock.setTimer(ARTIFACT_TTL_MS, () => {
      if (state.artifact?.id !== id) return;
      state.artifact = undefined;
      state.artifactCancel = undefined;
    });
    return {
      id,
      name: 'capture.png',
      mime: 'image/png',
      size: shot.png.byteLength,
      sha256: createHash('sha256').update(shot.png).digest('hex'),
      provenance: { session: state.id, generation, epoch },
      url: shot.url,
      token,
      inputWidth: shot.inputWidth,
      inputHeight: shot.inputHeight,
    };
  }

  function connect(channels: OwnerChannels): OwnerConnection {
    let lane: 'control' | 'media' | 'bulk' | undefined;
    let state: SessionState | undefined;
    let closed = false;
    let heartbeatCancel: (() => void) | undefined;

    /** One log line; the owner only has the error sink in production. */
    const log = (line: string): void => (deps.onError ?? report)(line);

    function stopHeartbeat(): void {
      heartbeatCancel?.();
      heartbeatCancel = undefined;
    }

    /** Any control message proves the client is alive; 6 s of silence is a loss. */
    function armHeartbeat(): void {
      stopHeartbeat();
      heartbeatCancel = clock.setTimer(HEARTBEAT_TIMEOUT_MS, () => {
        heartbeatCancel = undefined;
        loseControl();
      });
    }

    const fail = (code: 'busy' | 'unsupported' | 'rejected' | 'failed', message: string): void => {
      if (closed) return;
      closed = true;
      stopHeartbeat();
      // The client reads the media and bulk lanes as raw bytes only; there, log and close.
      if (lane === 'media' || lane === 'bulk')
        (deps.onError ?? report)(new Error(`${lane} lane ${code}: ${message}`));
      else channels.sendControl({ type: 'error', code, message });
      channels.close();
    };

    function closeMedia(target: SessionState): void {
      const media = target.media;
      target.media = undefined;
      media?.close();
    }

    /**
     * The control lane is gone. Release whatever it held, drop the lease, close
     * both lanes and keep the page for a reattach inside the grace.
     */
    function loseControl(): void {
      stopHeartbeat();
      closed = true;
      const target = state;
      state = undefined;
      if (target && sessions.get(target.id) === target) {
        const released = registry.release(target.id);
        if (released > 0) log(`released ${released} held inputs`);
        cancelUpload(target);
        target.control = undefined;
        // Pending media authentication belongs to the control lease that issued it.
        for (const [token, entry] of tokens) if (entry.session === target.id) tokens.delete(token);
        registry.detach(target.id);
        closeMedia(target);
        startGrace(target);
      }
      channels.close();
    }

    function bindMedia(token: string): void {
      const entry = tokens.get(token);
      if (!entry) {
        fail('rejected', 'Unknown media token');
        return;
      }
      // One use: the token is gone even if the session has since changed.
      tokens.delete(token);
      const target = sessions.get(entry.session);
      if (!target || target.generation !== entry.generation) {
        fail('rejected', 'Unknown media token');
        return;
      }
      state = target;
      target.media = channels;
      // A frame may have been encoded before the media lane attached; restore
      // both credits so the next paint is not stuck waiting for an ack.
      target.sink.grant('content');
      target.sink.grant('toolbar');
      // The paint for the viewport sent before this lane bound was dropped; a
      // static page would not paint again, so ask for a fresh one.
      if (target.viewport) target.pane.resize(target.viewport);
    }

    /** The bulk lane carries one authenticated artifact read, then closes. */
    function bindBulk(message: Extract<ControlMessage, { type: 'artifact' }>): void {
      if (message.action !== 'read') {
        fail('rejected', 'Bulk lane reads only');
        return;
      }
      if (!message.token) {
        fail('rejected', 'Missing artifact token');
        return;
      }
      let match: { state: SessionState; artifact: PendingArtifact } | undefined;
      for (const candidate of sessions.values()) {
        const artifact = candidate.artifact;
        if (artifact?.id === message.artifact && artifact.token === message.token) {
          match = { state: candidate, artifact };
          break;
        }
      }
      if (!match) {
        fail('rejected', 'Unknown artifact');
        return;
      }
      // One use: the pending capture is gone whether or not the bytes arrive.
      match.state.artifact = undefined;
      match.state.artifactCancel?.();
      match.state.artifactCancel = undefined;
      channels.sendMedia(match.artifact.bytes);
      closed = true;
      channels.close();
    }

    function handleControl(message: ControlMessage): void {
      armHeartbeat();
      switch (message.type) {
        case 'hello':
          fail('unsupported', 'Duplicate hello');
          return;
        case 'create':
        case 'create-android': {
          if (state) {
            fail('unsupported', 'Session already created');
            return;
          }
          let id: string;
          try {
            if (message.type === 'create-android' && !deps.android)
              throw new Error('This owner does not support Android devices');
            if (message.type === 'create' && deps.android)
              throw new Error('This owner accepts Android devices only');
            id = registry.create(message.url);
          } catch (error) {
            fail('failed', error instanceof Error ? error.message : 'Cannot open the pane');
            return;
          }
          const created = sessions.get(id);
          if (!created) {
            fail('failed', 'Cannot open the page');
            return;
          }
          const generation = registry.attach(id, 'remote');
          if (generation === 'busy') {
            fail('busy', 'Session is busy');
            return;
          }
          created.generation = generation;
          const token = newToken();
          tokens.set(token, { session: id, generation });
          state = created;
          created.control = channels;
          if (!created.pane.ready) {
            channels.sendControl({
              type: 'ready',
              request: message.request,
              session: id,
              generation,
              token,
            });
            return;
          }
          created.starting = true;
          void created.pane.ready.then(
            () => {
              created.starting = false;
              if (state !== created || created.control !== channels || created.closed || closed)
                return;
              channels.sendControl({
                type: 'ready',
                request: message.request,
                session: id,
                generation,
                token,
              });
            },
            (error: unknown) => {
              created.starting = false;
              if (created.closed) return;
              stopSession(id);
              if (state !== created || created.control !== channels || closed) return;
              fail('failed', error instanceof Error ? error.message : 'Cannot open Android device');
            },
          );
          return;
        }
        case 'attach': {
          if (state) {
            fail('unsupported', 'Session already created');
            return;
          }
          const target = sessions.get(message.session);
          if (!target) {
            fail('rejected', 'Unknown session');
            return;
          }
          if (target.starting) {
            fail('busy', 'Android device is still starting');
            return;
          }
          const generation = registry.attach(target.id, CONTROLLER);
          if (generation === 'busy') {
            fail('busy', 'Session is busy');
            return;
          }
          cancelGrace(target);
          target.generation = generation;
          // A new client process counts viewport epochs from 0 again; a stale
          // epoch would drop its viewport, input and frames.
          target.epoch = 0;
          target.viewport = undefined;
          target.sink.setEpoch(0);
          const token = newToken();
          tokens.set(token, { session: target.id, generation });
          state = target;
          target.control = channels;
          channels.sendControl({
            type: 'ready',
            request: message.request,
            session: target.id,
            generation,
            token,
          });
          // Nothing is replayed. The client's next viewport resizes and repaints,
          // and the new media lane restores both frame credits.
          return;
        }
        case 'detach': {
          if (!state) {
            fail('rejected', 'No session');
            return;
          }
          loseControl();
          return;
        }
        case 'viewport': {
          if (!state) {
            fail('rejected', 'No session');
            return;
          }
          // A viewport older than the current one is a late resize, not input.
          if (message.epoch >= state.epoch) {
            state.epoch = message.epoch;
            state.viewport = message;
            state.sink.setEpoch(message.epoch);
            state.pane.resize(message);
          }
          return;
        }
        case 'input': {
          if (!state) {
            fail('rejected', 'No session');
            return;
          }
          if (message.epoch !== state.epoch) return;
          registry.handleInput(state.id, message.generation, message.seq, message.event);
          return;
        }
        case 'credit':
          if (state) state.sink.grant(message.surface);
          return;
        case 'request': {
          if (!state) {
            fail('rejected', 'No session');
            return;
          }
          const request = message.request;
          const pane = state.pane;
          const target = state;
          const answer = (body: ControlMessage) => {
            if (!closed) channels.sendControl(body);
          };
          void (async () => {
            try {
              const value =
                message.tool === 'status'
                  ? await paneStatus(pane)
                  : message.tool === 'list'
                    ? await paneList(pane)
                    : message.tool === 'capture'
                      ? await storeCapture(target, pane, message.params)
                      : await paneTool(pane, message.tool, message.params);
              answer({ type: 'result', request, value: toJson(value) });
            } catch (error) {
              answer({ type: 'error', request, code: 'failed', message: errorText(error) });
            }
          })();
          return;
        }
        case 'upload-offer': {
          const upload = state?.upload;
          if (!state || !upload || upload.id !== message.chooser || upload.receiver) {
            channels.sendControl({
              type: 'error',
              code: 'rejected',
              message: 'No matching pending upload chooser',
            });
            return;
          }
          const retained = [...(state.retainedUploads ?? [])];
          if (
            retained.length >= 32 ||
            retained.reduce((sum, file) => sum + file.size, 0) + message.offer.size >
              MAX_ARTIFACT_BYTES
          ) {
            cancelUpload(state);
            channels.sendControl({
              type: 'error',
              code: 'rejected',
              message: 'Session upload storage limit reached',
            });
            return;
          }
          upload.receiver = createUploadReceiver(message.offer, upload.controller.signal);
          channels.sendControl({
            type: 'upload-grant',
            chooser: upload.id,
            token: upload.receiver.token,
          });
          return;
        }
        case 'upload-cancel':
          if (state?.upload?.id === message.chooser) cancelUpload(state);
          return;
        case 'heartbeat':
          return;
        case 'stop':
          stopHeartbeat();
          if (state) stopSession(state.id);
          state = undefined;
          closed = true;
          channels.close();
          return;
        default:
          fail('unsupported', `Unsupported ${message.type} message`);
          return;
      }
    }

    return {
      async receiveUpload(chooser, token, chunks) {
        if (closed || lane) throw new Error('Upload requires a fresh bulk lane');
        lane = 'bulk';
        const target = [...sessions.values()].find(
          (candidate) =>
            candidate.control &&
            candidate.upload?.id === chooser &&
            candidate.upload.receiver?.token === token,
        );
        const upload = target?.upload;
        if (!target || !upload?.receiver) throw new Error('Unknown upload grant');
        try {
          const retained = await upload.receiver.receive(
            token,
            touching(chunks, upload.touch),
            async (file) => {
              if (target.upload !== upload || upload.controller.signal.aborted)
                throw new Error('Upload canceled');
              await upload.chooser.install(file);
            },
          );
          if (target.upload !== upload || upload.controller.signal.aborted) {
            await retained.dispose();
            throw new Error('Upload canceled');
          }
          retainUpload(target, retained, upload.chooser.signal);
          if (target.upload === upload) {
            target.upload = undefined;
            upload.dispose();
            target.control?.sendControl({ type: 'upload-complete', chooser });
          }
        } catch (error) {
          if (target.upload === upload) cancelUpload(target);
          throw error;
        } finally {
          closed = true;
          channels.close();
        }
      },
      accept(message) {
        if (closed) return;
        if (!lane) {
          if (message.type === 'hello') {
            lane = 'control';
            if (!message.codecs.includes('png')) {
              fail('unsupported', 'PNG is required');
              return;
            }
            armHeartbeat();
            return;
          }
          if (message.type === 'media') {
            lane = 'media';
            bindMedia(message.token);
            return;
          }
          if (message.type === 'artifact') {
            lane = 'bulk';
            bindBulk(message);
            return;
          }
          return fail('rejected', 'Expected hello or media');
        }
        if (lane === 'media') return fail('rejected', 'Media connection accepts one frame');
        handleControl(message);
      },
      close() {
        if (closed) return;
        const target = state;
        if (!target || sessions.get(target.id) !== target) {
          closed = true;
          stopHeartbeat();
          return;
        }
        // A media lane closing only frees the sink; it must not detach the session.
        if (lane === 'media') {
          closed = true;
          if (target.media === channels) target.media = undefined;
          return;
        }
        loseControl();
      },
    };
  }

  function handleConnection(socket: Socket): void {
    const decoder = new FrameDecoder();
    // Partial bytes cannot keep an unclassified lane alive indefinitely.
    let handshakeCancel: (() => void) | undefined = clock.setTimer(30_000, () => socket.destroy());
    let connection: OwnerConnection | undefined;
    let uploadStream: PassThrough | undefined;
    let uploadEnded = false;
    const channels: OwnerChannels = {
      sendControl: (message) => {
        socket.write(encodeFrame('control', Buffer.from(JSON.stringify(message))));
      },
      sendMedia: (bytes) => {
        socket.write(bytes);
      },
      close: () => {
        socket.resume();
        socket.end();
      },
    };
    socket.on('data', (chunk: Buffer) => {
      try {
        for (const frame of decoder.push(chunk)) {
          if (uploadStream) {
            if (uploadEnded || frame.kind !== 'output')
              throw new Error('Upload accepts byte frames only');
            // Upload output frames are nonempty chunks; one empty output is EOF.
            // A sender must skip empty source chunks rather than encode them.
            if (frame.payload.length === 0) {
              uploadEnded = true;
              uploadStream.end();
            } else if (!uploadStream.write(frame.payload)) socket.pause();
            continue;
          }
          if (frame.kind !== 'control') throw new Error('Clients send control frames only');
          const value: unknown = JSON.parse(frame.payload.toString());
          const message = parseControl(value);
          handshakeCancel?.();
          handshakeCancel = undefined;
          if (message.type === 'upload-write') {
            if (connection) throw new Error('Upload requires a fresh bulk lane');
            connection = connect(channels);
            uploadStream = new PassThrough({ highWaterMark: 64 * 1024 });
            // A disconnect can precede the receiver's first iteration. Keep that
            // transport error handled even before its async iterator subscribes.
            uploadStream.on('error', () => {});
            uploadStream.on('drain', () => socket.resume());
            void connection
              .receiveUpload(message.chooser, message.token, uploadStream)
              .catch((error) => {
                (deps.onError ?? report)(error);
                uploadStream?.destroy();
                socket.destroy();
              });
          } else {
            connection ??= connect(channels);
            connection.accept(message);
          }
        }
      } catch (error) {
        (deps.onError ?? report)(error);
        socket.write(
          encodeFrame(
            'control',
            Buffer.from(
              JSON.stringify({ type: 'error', code: 'rejected', message: 'Invalid control frame' }),
            ),
          ),
        );
        socket.end();
      }
    });
    socket.on('error', () => socket.destroy());
    socket.on('close', () => {
      handshakeCancel?.();
      uploadStream?.destroy(new Error('Upload lane closed'));
      connection?.close();
    });
  }

  return { connect, handleConnection };
}

const REMOTE_COLS = 80;
const REMOTE_ROWS = 24;
const REMOTE_WIDTH = 1280;
const REMOTE_HEIGHT = 720;
const REMOTE_FEATURES = {
  keyboard: true,
  images: true,
  loadFrame: false,
  compositeFrame: false,
};
const REMOTE_SETTINGS = {
  overlay: false,
  design: false,
  transparent: false,
  noPaint: false,
  debugPaint: false,
};

/**
 * Terminal input shape consumed by the existing input handler; text is pasted.
 */
export function toTermEvent(event: InputEvent): TermEvent | null {
  switch (event.kind) {
    case 'key':
      return {
        eventType: 'key',
        keyEvent: {
          code: event.key,
          modifiers: event.modifiers ?? [],
          down: !event.up,
          isCharEvent:
            event.key.length === 1 &&
            !(event.modifiers ?? []).some((modifier) => modifier === 'ctrl' || modifier === 'meta'),
        },
      };
    case 'text':
      return { eventType: 'paste', paste: event.text };
    case 'pointer':
      return {
        eventType: 'mouse',
        mouseEvent: {
          kind:
            event.action === 'move'
              ? 'mouseMove'
              : event.action === 'down'
                ? 'mouseDown'
                : 'mouseUp',
          ...(event.button ? { button: event.button } : {}),
          x: event.x,
          y: event.y,
          modifiers: [],
        },
      };
    case 'wheel': {
      if (event.dy === 0 && event.dx === 0) return null;
      const kind =
        event.dy < 0
          ? 'scrollUp'
          : event.dy > 0
            ? 'scrollDown'
            : event.dx < 0
              ? 'scrollLeft'
              : 'scrollRight';
      return { eventType: 'mouse', mouseEvent: { kind, x: event.x, y: event.y, modifiers: [] } };
    }
  }
}

/** `registerPaintedContent` only reads `paintedContent` when a sink is present. */
function sinkContainerFrame(): InitialFrame {
  // Every loadFrame/free path sits behind `if (!sink)` in paint.ts, so this stub
  // is never dereferenced for a remote pane.
  return { paintedContent: 0 } as InitialFrame;
}

export interface RunningOwner {
  stop(): Promise<void>;
}

/** Runs the owner inside the Electron app started with `--remote-owner`. */
export async function startElectronOwner(onIdle: () => void): Promise<RunningOwner> {
  const [
    { createWindowWithToolbar },
    { registerPaintedContent },
    { createTerminalContext },
    { createInputHandler },
    { ownerAssets },
    { debuggerManager },
    { createBrowserToolRegistry },
  ] = await Promise.all([
    import('../windows'),
    import('../paint'),
    import('../terminal/context'),
    import('../inputHandler'),
    import('../browserOwner/assets'),
    import('../browserOwner/debugger'),
    import('../browserOwner/tools/browserTools'),
  ]);
  const assets = ownerAssets(process.argv[1]);
  const containerFrame = sinkContainerFrame();
  const tools = createBrowserToolRegistry();

  const owner = createOwner({
    onIdle,
    openPane: (url, id, sink, onClipboard, onExternal, onFileChooserUnsupported, onFileChooser) => {
      const terminal = createTerminalContext(
        id,
        { cols: REMOTE_COLS, rows: REMOTE_ROWS, width: REMOTE_WIDTH, height: REMOTE_HEIGHT },
        REMOTE_FEATURES,
        () => {},
        REMOTE_SETTINGS,
      );
      let view: WindowView | undefined;
      let painted: ReturnType<typeof registerPaintedContent> | undefined;
      let pending: Viewport | undefined;
      let closed = false;
      let focusLease: ReturnType<typeof debuggerManager.acquire> | undefined;
      // One tool call at a time per session; the next waits for the previous result.
      let queue: Promise<unknown> = Promise.resolve();
      const serialize = <T>(run: () => Promise<T>): Promise<T> => {
        const next = queue.then(run, run);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      };
      const input = createInputHandler(
        () => view ?? null,
        () => (view ? [view] : []),
      );

      void createWindowWithToolbar({ width: REMOTE_WIDTH, height: REMOTE_HEIGHT }, url, {
        terminal,
        onCopyToClipboard: onClipboard,
        ...(onExternal ? { onOpenExternal: onExternal } : {}),
        ...(onFileChooserUnsupported ? { onFileChooserUnsupported } : {}),
        ...(onFileChooser
          ? {
              onFileChooser: (
                options: Electron.OpenDialogOptions,
                signal: AbortSignal,
                install: (file: string) => Promise<void>,
              ) => {
                if (options.properties?.includes('multiSelections')) {
                  onFileChooserUnsupported?.();
                  return Promise.resolve({ canceled: true, filePaths: [] });
                }
                return requestRemoteFile(onFileChooser, signal, install);
              },
            }
          : {}),
        // The sink owns painting; the window must not register SHM/terminal paints.
        isActive: () => false,
        onResize: () => painted?.refresh(),
        assetDirectory: assets.directory,
      })
        .then((created) => {
          if (closed) {
            created.destroy();
            return;
          }
          view = created;
          painted = registerPaintedContent(
            containerFrame,
            created.content,
            created.contentNode,
            terminal,
            () => true,
            sink,
            { window: created.toolbar, layout: created.toolbarNode },
          );
          if (pending) {
            terminal.size = {
              cols: pending.cols,
              rows: pending.rows,
              width: pending.width,
              height: pending.height,
            };
            pending = undefined;
          }
          created.relayout(true);
          created.refresh();
          // A headless window never gets OS focus, so the page would never see
          // focus (no autofocus, no focused field). Emulate it while the pane lives;
          // the emulation ends when the lease detaches.
          focusLease = debuggerManager.acquire(created.content.webContents);
          focusLease
            .sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
            .catch((error: unknown) => report(error));
        })
        .catch((error: unknown) => report(error));

      return {
        input(event) {
          if (!view) return;
          const mapped = toTermEvent(event);
          if (mapped) input.handleInput(mapped);
        },
        resize(viewport) {
          if (!view) {
            pending = viewport;
            return;
          }
          terminal.size = {
            cols: viewport.cols,
            rows: viewport.rows,
            width: viewport.width,
            height: viewport.height,
          };
          view.relayout(true);
          view.refresh();
        },
        callTool(name, params) {
          return serialize(async () => {
            const current = view;
            if (closed || !current) throw new Error('The remote page is not ready');
            const def = tools.get(name);
            await tools.validate(name, params);
            const value = await withTimeout(
              () => def.handler(params, { webContents: current.content.webContents }),
              def.timeoutMs,
            );
            return toJson(value);
          });
        },
        listTools() {
          return toJson({ tools: tools.listTools() });
        },
        capture(options) {
          return serialize(async () => {
            const current = view;
            if (closed || !current) throw new Error('The remote page is not ready');
            const shot = await capturePagePng(current, options);
            return {
              png: shot.png,
              url: shot.url,
              inputWidth: shot.inputWidth,
              inputHeight: shot.inputHeight,
            };
          });
        },
        async status() {
          const current = view;
          const webContents = current?.content.webContents;
          return {
            url: !closed && webContents ? webContents.getURL() : url,
            loading: !closed && (!webContents || webContents.isLoading()),
            target: {
              kind: 'web',
              state: closed ? 'closed' : current ? 'ready' : 'starting',
              capabilities: {
                capture: true,
                tools: true,
                input: ['key', 'text', 'pointer', 'wheel'],
              },
            },
          };
        },
        close() {
          closed = true;
          focusLease?.release();
          painted?.destroy();
          view?.destroy();
          terminal.dispose();
        },
      };
    },
  });

  const supervisor = await startSupervisor({
    dir: supervisorDir(ownerBuildIdentity(process.argv[1])),
    startOwner: async () => {},
    stopOwner: async () => {},
    onConnection: (socket) => owner.handleConnection(socket),
  });
  void sweepStaleUploads(pidAlive).catch(report);

  return { stop: () => supervisor.stop() };
}
