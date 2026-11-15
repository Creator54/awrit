/**
 * Remote protocol v1: typed control messages, their validator, and the media envelope.
 * No I/O. Control messages travel in `encodeFrame('control', …)` and `FrameDecoder`
 * from `../browserOwner/protocol`; this file does not repeat that framing.
 *
 * All bytes here are untrusted. Every limit is enforced before allocating.
 */

import { type ArtifactOffer, parseArtifactOffer } from './artifacts';

export const LIMITS = {
  control: 64 * 1024,
  /** Clipboard text bytes; bounded so one copy fits a control frame. */
  clipboard: 16 * 1024,
  /** External link bytes; a page asks the terminal to open one local browser tab. */
  externalUrl: 4096,
  mediaMeta: 8 * 1024,
  mediaPayload: 8 * 1024 * 1024,
  maxSide: 4096,
  maxPixels: 8_294_400,
  outstandingRequests: 32,
} as const;

export type Codec = 'jpeg' | 'png';
export type Surface = 'content' | 'toolbar';
export type SurfaceAction = 'create' | 'remove' | 'cover' | 'uncover';
export type ArtifactAction = 'offer' | 'read' | 'ack';
export type ErrorCode = 'busy' | 'unsupported' | 'rejected' | 'failed';
export type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta';
export type PointerButton = 'left' | 'middle' | 'right';
export type PointerAction = 'move' | 'down' | 'up';

export type InputEvent =
  | { kind: 'key'; key: string; modifiers?: Modifier[]; up?: true }
  | { kind: 'text'; text: string }
  | { kind: 'pointer'; action: PointerAction; x: number; y: number; button?: PointerButton }
  | { kind: 'wheel'; x: number; y: number; dx: number; dy: number };

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Tool results must travel as plain JSON; undefined fields are dropped. */
export function toJson(value: unknown): JsonValue {
  const text = JSON.stringify(value);
  return text === undefined ? null : (JSON.parse(text) as JsonValue);
}

/**
 * A control connection is bound to one session after `create` or `attach`, so messages
 * carry no session id. The owner answers with `ready`, whose one-use `token` the client
 * sends as the only control frame on its media connection to bind it to the session. `input.epoch` and `input.generation` let the owner reject
 * position-sensitive events from a stale viewport or an old controller.
 */
export type ControlMessage =
  | { type: 'hello'; version: 1; build: string; codecs: Codec[] }
  | { type: 'create'; request: string; url: string }
  | { type: 'create-android'; request: string; device: string; url: string }
  | { type: 'ready'; request: string; session: string; generation: number; token: string }
  | { type: 'media'; token: string }
  | { type: 'attach'; request: string; session: string }
  | { type: 'detach' }
  | { type: 'stop'; request: string }
  | { type: 'list'; request: string }
  | { type: 'viewport'; epoch: number; width: number; height: number; cols: number; rows: number }
  | { type: 'input'; seq: number; generation: number; epoch: number; event: InputEvent }
  | { type: 'request'; request: string; tool: string; params: JsonValue }
  | { type: 'result'; request: string; value: JsonValue }
  | { type: 'error'; request?: string; code: ErrorCode; message: string }
  | { type: 'cancel'; request: string }
  | { type: 'surface'; surface: Surface; action: SurfaceAction }
  | { type: 'credit'; surface: Surface }
  | { type: 'heartbeat' }
  | { type: 'clipboard'; text: string }
  | { type: 'external-link'; url: string }
  | { type: 'file-chooser-unsupported' }
  | { type: 'file-chooser'; chooser: string }
  | { type: 'upload-offer'; chooser: string; offer: ArtifactOffer }
  | { type: 'upload-grant' | 'upload-write'; chooser: string; token: string }
  | { type: 'upload-cancel' | 'upload-complete'; chooser: string }
  | {
      type: 'artifact';
      artifact: string;
      action: ArtifactAction;
      size?: number;
      mime?: string;
      hash?: string;
      /** One-use read token from the capture offer; guards the bulk lane. */
      token?: string;
    };

export interface MediaMeta {
  session: string;
  surface: Surface;
  generation: number;
  epoch: number;
  frame: number;
  codec: Codec;
  width: number;
  height: number;
  x: number;
  y: number;
  z: number;
}

export interface MediaFrame {
  meta: MediaMeta;
  payload: Buffer;
}

type Fields = Record<string, unknown>;

const codecs: readonly Codec[] = ['jpeg', 'png'];
const surfaces: readonly Surface[] = ['content', 'toolbar'];
const surfaceActions: readonly SurfaceAction[] = ['create', 'remove', 'cover', 'uncover'];
const artifactActions: readonly ArtifactAction[] = ['offer', 'read', 'ack'];
const errorCodes: readonly ErrorCode[] = ['busy', 'unsupported', 'rejected', 'failed'];
const modifiers: readonly Modifier[] = ['ctrl', 'alt', 'shift', 'meta'];
const pointerActions: readonly PointerAction[] = ['move', 'down', 'up'];
const pointerButtons: readonly PointerButton[] = ['left', 'middle', 'right'];
const mediaKeys = [
  'session',
  'surface',
  'generation',
  'epoch',
  'frame',
  'codec',
  'width',
  'height',
  'x',
  'y',
  'z',
] as const;

function record(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid protocol object');
  return Object.fromEntries(Object.entries(value));
}

function exact(value: Fields, keys: readonly string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new Error('Unexpected protocol fields');
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max)
    throw new Error('Invalid protocol text');
  return value;
}

function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value))
    throw new Error('Invalid protocol id');
  return value;
}

/** Only web pages; the host's browser must not open local files or other schemes. */
function pageUrl(value: unknown): string {
  const raw = text(value, 2048);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error('Invalid page URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error('Invalid page URL');
  return raw;
}

/** Clipboard text: non-empty and capped by UTF-8 bytes, not UTF-16 units. */
function clipboardText(value: unknown): string {
  const raw = text(value, LIMITS.clipboard);
  if (Buffer.byteLength(raw, 'utf8') > LIMITS.clipboard)
    throw new Error('Oversized clipboard text');
  return raw;
}

/**
 * A link from a page to the user's local browser: canonical http(s), no credentials
 * and no control characters, capped by UTF-8 bytes. The client only shows it.
 */
export function externalUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1) throw new Error('Invalid external URL');
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejects terminal controls
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('Invalid external URL');
  if (Buffer.byteLength(value, 'utf8') > LIMITS.externalUrl)
    throw new Error('Oversized external URL');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid external URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error('Invalid external URL');
  if (parsed.username || parsed.password) throw new Error('Invalid external URL');
  // Canonical form only, so a different spelling is not passed on as if it were trusted.
  if (parsed.toString() !== value) throw new Error('Invalid external URL');
  return value;
}

/** Non-negative safe integer. */
function count(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new Error('Invalid protocol integer');
  return value;
}

/** Integer in 1..max. */
function positive(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > max)
    throw new Error('Invalid protocol dimension');
  return value;
}

/** Non-negative integer up to max, e.g. a terminal cell coordinate. */
function within(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > max)
    throw new Error('Invalid protocol coordinate');
  return value;
}

/** Integer in -max..max, e.g. a scroll delta. */
function offset(value: unknown, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || Math.abs(value) > max)
    throw new Error('Invalid protocol offset');
  return value;
}

function oneOf<T extends string>(value: unknown, options: readonly T[]): T {
  for (const option of options) if (option === value) return option;
  throw new Error('Invalid protocol value');
}

/** JSON-safe value at the tool-parameter boundary; bounded depth prevents deep recursion. */
function json(value: unknown, depth = 0): void {
  if (depth > 16) throw new Error('Nested protocol JSON');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Invalid protocol JSON number');
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) json(item, depth + 1);
    return;
  }
  if (typeof value === 'object') {
    for (const item of Object.values(value)) json(item, depth + 1);
    return;
  }
  throw new Error('Invalid protocol JSON value');
}

function modifierList(value: unknown): void {
  if (!Array.isArray(value) || value.length > modifiers.length)
    throw new Error('Invalid protocol modifiers');
  for (const modifier of value) oneOf(modifier, modifiers);
}

function inputEvent(value: unknown): void {
  const event = record(value);
  const kind = event.kind;
  if (typeof kind !== 'string') throw new Error('Unknown input event');
  switch (kind) {
    case 'key': {
      const withModifiers = Object.hasOwn(event, 'modifiers');
      const isUp = Object.hasOwn(event, 'up');
      exact(event, [
        'kind',
        'key',
        ...(withModifiers ? ['modifiers'] : []),
        ...(isUp ? ['up'] : []),
      ]);
      text(event.key, 64);
      if (withModifiers) modifierList(event.modifiers);
      if (isUp && event.up !== true) throw new Error('Key up must be true');
      return;
    }
    case 'text':
      exact(event, ['kind', 'text']);
      text(event.text, 1024);
      return;
    case 'pointer': {
      const action = oneOf(event.action, pointerActions);
      const withButton = Object.hasOwn(event, 'button');
      exact(
        event,
        withButton ? ['kind', 'action', 'x', 'y', 'button'] : ['kind', 'action', 'x', 'y'],
      );
      within(event.x, 65535);
      within(event.y, 65535);
      // Releasing the button is what clears held input, so down/up carry one and moves do not.
      if (action === 'move' ? withButton : !withButton) throw new Error('Invalid pointer button');
      if (withButton) oneOf(event.button, pointerButtons);
      return;
    }
    case 'wheel':
      exact(event, ['kind', 'x', 'y', 'dx', 'dy']);
      within(event.x, 65535);
      within(event.y, 65535);
      offset(event.dx, 65535);
      offset(event.dy, 65535);
      return;
    default:
      throw new Error('Unknown input event');
  }
}

function mediaMeta(value: unknown): MediaMeta {
  const meta = record(value);
  exact(meta, mediaKeys);
  id(meta.session);
  oneOf(meta.surface, surfaces);
  count(meta.generation);
  count(meta.epoch);
  count(meta.frame);
  oneOf(meta.codec, codecs);
  const width = positive(meta.width, LIMITS.maxSide);
  const height = positive(meta.height, LIMITS.maxSide);
  if (width * height > LIMITS.maxPixels) throw new Error('Oversized media dimensions');
  count(meta.x);
  count(meta.y);
  count(meta.z);
  return value as MediaMeta;
}

export function parseControl(value: unknown): ControlMessage {
  const message = record(value);
  const type = message.type;
  if (typeof type !== 'string') throw new Error('Unknown control message');
  switch (type) {
    case 'hello': {
      exact(message, ['type', 'version', 'build', 'codecs']);
      if (message.version !== 1) throw new Error('Unsupported protocol version');
      text(message.build, 128);
      const offered = message.codecs;
      if (!Array.isArray(offered) || offered.length < 1 || offered.length > codecs.length)
        throw new Error('Invalid protocol codecs');
      const seen = new Set<Codec>();
      for (const item of offered) {
        const codec = oneOf(item, codecs);
        if (seen.has(codec)) throw new Error('Duplicate protocol codec');
        seen.add(codec);
      }
      break;
    }
    case 'create':
      exact(message, ['type', 'request', 'url']);
      id(message.request);
      pageUrl(message.url);
      break;
    case 'create-android': {
      exact(message, ['type', 'request', 'device', 'url']);
      id(message.request);
      text(message.device, 128);
      if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(String(message.device)))
        throw new Error('Invalid Android device selector');
      if (message.url !== `android://${encodeURIComponent(String(message.device))}`)
        throw new Error('Invalid Android device URL');
      const deviceUrl = new URL(String(message.url));
      if (deviceUrl.protocol !== 'android:' || !deviceUrl.hostname)
        throw new Error('Invalid Android device URL');
      if (deviceUrl.pathname || deviceUrl.search || deviceUrl.hash)
        throw new Error('Unexpected Android URL fields');
      if (decodeURIComponent(deviceUrl.hostname) !== message.device)
        throw new Error('Android URL does not match its device');
      break;
    }
    case 'ready':
      exact(message, ['type', 'request', 'session', 'generation', 'token']);
      id(message.request);
      id(message.session);
      count(message.generation);
      id(message.token);
      break;
    case 'media':
      exact(message, ['type', 'token']);
      id(message.token);
      break;
    case 'attach':
      exact(message, ['type', 'request', 'session']);
      id(message.request);
      id(message.session);
      break;
    case 'detach':
      exact(message, ['type']);
      break;
    case 'stop':
      exact(message, ['type', 'request']);
      id(message.request);
      break;
    case 'list':
      exact(message, ['type', 'request']);
      id(message.request);
      break;
    case 'viewport':
      exact(message, ['type', 'epoch', 'width', 'height', 'cols', 'rows']);
      count(message.epoch);
      positive(message.width, LIMITS.maxSide);
      positive(message.height, LIMITS.maxSide);
      positive(message.cols, 65535);
      positive(message.rows, 65535);
      break;
    case 'input':
      exact(message, ['type', 'seq', 'generation', 'epoch', 'event']);
      count(message.seq);
      count(message.generation);
      count(message.epoch);
      inputEvent(message.event);
      break;
    case 'request':
      exact(message, ['type', 'request', 'tool', 'params']);
      id(message.request);
      text(message.tool, 64);
      json(message.params);
      break;
    case 'result':
      exact(message, ['type', 'request', 'value']);
      id(message.request);
      json(message.value);
      break;
    case 'error': {
      const withRequest = Object.hasOwn(message, 'request');
      exact(
        message,
        withRequest ? ['type', 'request', 'code', 'message'] : ['type', 'code', 'message'],
      );
      if (withRequest) id(message.request);
      oneOf(message.code, errorCodes);
      text(message.message, 1024);
      break;
    }
    case 'cancel':
      exact(message, ['type', 'request']);
      id(message.request);
      break;
    case 'surface':
      exact(message, ['type', 'surface', 'action']);
      oneOf(message.surface, surfaces);
      oneOf(message.action, surfaceActions);
      break;
    case 'credit':
      exact(message, ['type', 'surface']);
      oneOf(message.surface, surfaces);
      break;
    case 'heartbeat':
      exact(message, ['type']);
      break;
    case 'clipboard':
      exact(message, ['type', 'text']);
      clipboardText(message.text);
      break;
    case 'external-link':
      exact(message, ['type', 'url']);
      externalUrl(message.url);
      break;
    case 'file-chooser':
    case 'upload-cancel':
    case 'upload-complete':
      exact(message, ['type', 'chooser']);
      id(message.chooser);
      break;
    case 'upload-offer':
      exact(message, ['type', 'chooser', 'offer']);
      id(message.chooser);
      parseArtifactOffer(message.offer);
      break;
    case 'upload-grant':
    case 'upload-write':
      exact(message, ['type', 'chooser', 'token']);
      id(message.chooser);
      id(message.token);
      break;
    case 'file-chooser-unsupported':
      exact(message, ['type']);
      break;
    case 'artifact': {
      const action = oneOf(message.action, artifactActions);
      const offer = action === 'offer';
      const withToken = !offer && Object.hasOwn(message, 'token');
      exact(
        message,
        offer
          ? ['type', 'artifact', 'action', 'size', 'mime', 'hash']
          : ['type', 'artifact', 'action', ...(withToken ? ['token'] : [])],
      );
      id(message.artifact);
      if (offer) {
        count(message.size);
        text(message.mime, 255);
        if (typeof message.hash !== 'string' || !/^[a-f0-9]{64}$/.test(message.hash))
          throw new Error('Invalid artifact hash');
      }
      if (withToken) id(message.token);
      break;
    }
    default:
      throw new Error('Unknown control message');
  }
  // Every field of every message type was checked above, including exact nested keys.
  return value as ControlMessage;
}

export function encodeMediaEnvelope(meta: MediaMeta, payload: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(mediaMeta(meta)));
  if (json.length > LIMITS.mediaMeta) throw new Error('Oversized media metadata');
  if (payload.byteLength < 1 || payload.byteLength > LIMITS.mediaPayload)
    throw new Error('Oversized media payload');
  const envelope = Buffer.allocUnsafe(8 + json.length + payload.byteLength);
  envelope.writeUInt32BE(json.length, 0);
  envelope.writeUInt32BE(payload.byteLength, 4);
  json.copy(envelope, 8);
  envelope.set(payload, 8 + json.length);
  return envelope;
}

/** Streaming decoder: keeps one bounded partial envelope between reads. */
export class MediaDecoder {
  private readonly header = Buffer.alloc(8);
  private headerBytes = 0;
  private meta: Buffer | undefined;
  private metaBytes = 0;
  private payload: Buffer | undefined;
  private payloadBytes = 0;

  push(chunk: Uint8Array): MediaFrame[] {
    const frames: MediaFrame[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.headerBytes < 8) {
        const count = Math.min(8 - this.headerBytes, chunk.byteLength - offset);
        this.header.set(chunk.subarray(offset, offset + count), this.headerBytes);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes < 8) continue;
        const metaLength = this.header.readUInt32BE(0);
        const payloadLength = this.header.readUInt32BE(4);
        if (metaLength < 1 || metaLength > LIMITS.mediaMeta)
          throw new Error('Oversized media metadata');
        if (payloadLength < 1 || payloadLength > LIMITS.mediaPayload)
          throw new Error('Oversized media payload');
        this.meta = Buffer.allocUnsafe(metaLength);
        this.payload = Buffer.allocUnsafe(payloadLength);
      }
      const meta = this.meta;
      const payload = this.payload;
      if (!meta || !payload) throw new Error('Missing media envelope');
      if (this.metaBytes < meta.length) {
        const count = Math.min(meta.length - this.metaBytes, chunk.byteLength - offset);
        meta.set(chunk.subarray(offset, offset + count), this.metaBytes);
        this.metaBytes += count;
        offset += count;
        if (this.metaBytes < meta.length) continue;
      }
      const count = Math.min(payload.length - this.payloadBytes, chunk.byteLength - offset);
      payload.set(chunk.subarray(offset, offset + count), this.payloadBytes);
      this.payloadBytes += count;
      offset += count;
      if (this.payloadBytes < payload.length) continue;
      frames.push({ meta: parseMediaMeta(meta), payload });
      this.headerBytes = 0;
      this.meta = undefined;
      this.metaBytes = 0;
      this.payload = undefined;
      this.payloadBytes = 0;
    }
    return frames;
  }
}

function parseMediaMeta(bytes: Buffer): MediaMeta {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Invalid media metadata JSON');
  }
  return mediaMeta(value);
}

/** Convenience for one complete envelope; use `MediaDecoder` for a stream. */
export function decodeMediaEnvelope(bytes: Uint8Array): MediaFrame[] {
  const frames = new MediaDecoder().push(bytes);
  if (frames.length !== 1) throw new Error('Expected exactly one media envelope');
  return frames;
}
