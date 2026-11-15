import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAdbSerialForDevice, listConnectedAdbDevices } from '../adb/androidManager';
import { readCodeSnapshot } from '../design/codeSource';
import { getAppDataPath } from '../paths';
import { getSocketPath, isSocketAlive } from '../ipc/socketServer';
import { findRemotePane } from '../remote/registry';
import { parseCaptureProvenance, type CaptureProvenance } from '../remote/captureProvenance';
import { loadOverlayState } from './overlayToggle';
import { resolvePresentationTarget } from './target';
import { normalizeTargetUrl } from './sessionOwnership';
import { isLocalMiss, REMOTE_TIMEOUT_MS, readStatus, request } from './toolClient';

import {
  type RegionBox,
  normalizeRegionBox,
} from '../design/regionBox';

export type { RegionBox };
export { normalizeRegionBox };

export interface CollaborativeCapture {
  sentRevisions?: Record<string, string[]>;
  id: string;
  timestamp: number;
  target: string;
  isAdb: boolean;
  imagePath: string;
  width: number;
  height: number;
  sha256: string;
  region?: RegionBox;
  comment?: string;
  caption: string;
  marker: string;
  author: 'user' | 'agent';
  source?: { path: string; sha256: string; text: string };
  captureOrigin?: { kind: 'live-viewer'; paneId: string; provenance?: CaptureProvenance } | { kind: 'headless' | 'android' };
  /** Multiply original PNG pixel coordinates by these factors for tool input; valid only while the viewer size is unchanged. */
  inputCoordinates?: { space: 'viewer'; width: number; height: number; scaleX: number; scaleY: number };
}

export interface CreateFrozenCaptureOptions {
  target?: string;
  region?: unknown;
  comment?: string;
  author?: 'user' | 'agent';
  sourceWindowId?: number;
  entryPath?: string;
  electronPath?: string;
  pruneLimit?: number;
  waitMs?: number;
  waitSelector?: string;
}

const CAPTURE_ID_REGEX = /^cap-[a-f0-9]{12}$/;
const MAX_COMMENT_LENGTH = 4096;
const MAX_CAPTION_LENGTH = 120;
const MAX_CAPTURES_STORED = 50;

export function isValidCaptureId(id: unknown): id is string {
  return typeof id === 'string' && CAPTURE_ID_REGEX.test(id);
}

export function getCapturesDir(): string {
  const dir = path.join(getAppDataPath(), 'captures');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function sanitizeCaptureComment(raw?: string): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') return undefined;

  // Reject/strip C0 and C1 controls except LF (0x0A), CR (0x0D), and TAB (0x09)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: sanitize control characters from comments
  const sanitized = raw.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u0080-\u009f]/g, '').trim();
  if (!sanitized) return undefined;

  return sanitized.length > MAX_COMMENT_LENGTH ? sanitized.slice(0, MAX_COMMENT_LENGTH) : sanitized;
}

export function formatMarkerCaption(comment?: string, fallback = 'capture'): string {
  if (!comment) return fallback;
  const clean = comment
    .replace(/[[\]]/g, '')
    .replace(/[\r\n\t]+/g, ' ')
    .trim();
  if (!clean) return fallback;
  return clean.length > MAX_CAPTION_LENGTH ? `${clean.slice(0, MAX_CAPTION_LENGTH - 3)}...` : clean;
}

function parsePngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) {
    throw new Error('Buffer too small to be a valid PNG');
  }
  // PNG Signature: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] !== 0x89 ||
    buf[1] !== 0x50 ||
    buf[2] !== 0x4e ||
    buf[3] !== 0x47 ||
    buf[4] !== 0x0d ||
    buf[5] !== 0x0a ||
    buf[6] !== 0x1a ||
    buf[7] !== 0x0a
  ) {
    throw new Error('Invalid PNG signature');
  }
  // IHDR chunk begins at offset 12 with tag 'IHDR'
  if (buf[12] !== 0x49 || buf[13] !== 0x48 || buf[14] !== 0x44 || buf[15] !== 0x52) {
    throw new Error('PNG missing initial IHDR chunk');
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);

  if (width === 0 || height === 0) {
    throw new Error('Invalid zero PNG dimensions');
  }
  return { width, height };
}

export function pruneOldCaptures(maxRetained = MAX_CAPTURES_STORED): void {
  const dir = getCapturesDir();
  try {
    const files = fs.readdirSync(dir);
    const now = Date.now();
    for (const file of files) {
      if (!/^cap-[a-f0-9]{8,32}(?:\.(?:png|json)\.[a-f0-9]{8}\.tmp|\.tmp-snap\.png)$/.test(file)) continue;
      const temporary = path.join(dir, file);
      try {
        const stat = fs.lstatSync(temporary);
        if (stat.isFile() && now - stat.mtimeMs > 3600_000) fs.unlinkSync(temporary);
      } catch {}
    }
    const jsonFiles = files.filter((f) => f.startsWith('cap-') && f.endsWith('.json'));

    if (jsonFiles.length <= maxRetained) return;

    const stats = jsonFiles.map((f) => {
      const fullPath = path.join(dir, f);
      const st = fs.statSync(fullPath);
      return { file: f, path: fullPath, mtimeMs: st.mtimeMs };
    });

    stats.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const toRemove = stats.slice(maxRetained);
    for (const item of toRemove) {
      try {
        fs.unlinkSync(item.path);
        const pngPath = item.path.replace(/\.json$/, '.png');
        if (fs.existsSync(pngPath)) {
          fs.unlinkSync(pngPath);
        }
      } catch {}
    }
  } catch {}
}

export async function createFrozenCapture(
  options: CreateFrozenCaptureOptions = {},
): Promise<CollaborativeCapture> {
  const capturesDir = getCapturesDir();
  const id = `cap-${randomBytes(6).toString('hex')}`;

  // 1. Resolve Target
  let targetDevice: string | undefined;
  let targetUrl = options.target ? options.target.trim() : undefined;

  if (!targetDevice && !targetUrl) {
    const windowId = options.sourceWindowId !== undefined ? String(options.sourceWindowId) : process.env.KITTY_WINDOW_ID;
    const status = await readStatus(options.sourceWindowId !== undefined ? String(options.sourceWindowId) : undefined);
    if (status.viewers.length > 1) throw new Error('Several viewers are open; specify a capture target');
    const viewer = status.viewers[0];
    if (viewer) {
      const frame = await captureViewerFrame(viewer.paneId, windowId, options);
      const base64: unknown = frame && typeof frame === 'object' ? Reflect.get(frame, 'base64') : undefined;
      const url: unknown = frame && typeof frame === 'object' ? Reflect.get(frame, 'url') : undefined;
      if (typeof base64 !== 'string' || typeof url !== 'string') throw new Error('Invalid live capture reply');
      const android = Reflect.get(frame as object, 'isAdb') === true;
      const source = android ? undefined : await readCodeSnapshot(url);
      return persistCapture(Buffer.from(base64, 'base64'), url, android, options, id, source,
        { kind: 'live-viewer', paneId: viewer.paneId, ...liveProvenance(frame) }, liveInputSize(frame));
    }
  }

  if (!targetDevice && !targetUrl && options.sourceWindowId) {
    const session = loadOverlayState(options.sourceWindowId);
    if (session) {
      targetUrl = session.target;
    }
  }

  let connectedCount = 0;
  if (!targetDevice && !targetUrl) {
    // Check connected devices
    try {
      const connected = await listConnectedAdbDevices();
      connectedCount = connected.length;
      if (connected.length === 1) {
        targetDevice = connected[0];
      }
    } catch {}
  }

  if (!targetDevice && !targetUrl) {
    throw new Error(
      connectedCount > 1
        ? 'Several devices are connected; pass a TARGET or run: awrit device screenshot NAME'
        : 'No viewer or connected device; pass a TARGET or run: awrit device screenshot NAME',
    );
  }

  const requestedSource = !targetDevice && targetUrl ? await readCodeSnapshot(targetUrl) : undefined;

  // 2. Capture PNG buffer
  let pngBuffer!: Buffer;
  let isAdb = false;
  let resolvedTarget = '';
  let captureOrigin: CollaborativeCapture['captureOrigin'];
  let inputSize: { width: number; height: number } | undefined;

  if (targetDevice) {
    const { captureDeviceScreenshot } = await import('../adb/androidManager');
    const shot = await captureDeviceScreenshot(targetDevice);
    if (!shot.ok || !shot.base64) {
      throw new Error(shot.error ?? `Failed to capture screenshot from ${targetDevice}`);
    }
    pngBuffer = Buffer.from(shot.base64, 'base64');
    isAdb = true;
    captureOrigin = { kind: 'android' };
    resolvedTarget = getAdbSerialForDevice(targetDevice);
  } else {
    // 1. Live viewer fast-path: if an active viewer is open, capture directly from its live session
    const sockPath = getSocketPath();
    let capturedFromViewer = false;

    if (await isSocketAlive(sockPath, 200)) {
      try {
        const net = await import('node:net');
        const client = net.connect(sockPath);
        const reqId = randomBytes(4).toString('hex');

        const liveFrame = await new Promise<{ base64: string; url: string; paneId?: string; inputWidth?: number; inputHeight?: number }>((resolve, reject) => {
          const timeout = setTimeout(() => {
            client.destroy();
            reject(new Error('Live capture request timed out'));
          }, 3000);

          let buf = '';
          client.on('connect', () => {
            client.write(
              JSON.stringify({
                type: 'capture:request',
                requestId: reqId,
                target: targetUrl,
                sourceWindowId: options.sourceWindowId !== undefined ? String(options.sourceWindowId) : process.env.KITTY_WINDOW_ID,
                ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
                ...(options.waitSelector !== undefined ? { waitSelector: options.waitSelector } : {}),
              }) + '\n',
            );
          });

          client.on('data', (chunk) => {
            buf += chunk.toString();
            const lines = buf.split('\n');
            buf = lines.pop() || '';
            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const msg = JSON.parse(line);
                if (msg.type === 'capture:request:response' && msg.requestId === reqId) {
                  clearTimeout(timeout);
                  client.destroy();
                  if (msg.ok && msg.data?.base64) {
                    resolve(msg.data);
                  } else {
                    reject(new Error(msg.error || 'Failed to capture frame from viewer'));
                  }
                  return;
                }
              } catch {}
            }
          });

          client.on('error', (err) => {
            clearTimeout(timeout);
            client.destroy();
            reject(err);
          });
        });

        if (liveFrame?.base64 && normalizeTargetUrl(liveFrame.url) === normalizeTargetUrl(targetUrl as string)) {
          pngBuffer = Buffer.from(liveFrame.base64, 'base64');
          isAdb = false;
          resolvedTarget = liveFrame.url || resolvePresentationTarget(targetUrl as string).url;
          capturedFromViewer = true;
          inputSize = liveInputSize(liveFrame);
          if (typeof liveFrame.paneId === 'string') captureOrigin = { kind: 'live-viewer', paneId: liveFrame.paneId, ...liveProvenance(liveFrame) };
        }
      } catch (_e) {
        // Fall back to headless capture
      }
    }

    if (!capturedFromViewer) {
      const { captureSnapshot } = await import('./capture');
      const entryPath = options.entryPath ?? process.env.AWRIT_CAPTURE_ENTRY;
      if (!entryPath) {
        throw new Error('AWRIT_CAPTURE_ENTRY is required for web snapshot captures');
      }
      const tempShot = path.join(capturesDir, `${id}.tmp-snap.png`);
      try {
        await captureSnapshot({
          target: targetUrl as string,
          out: tempShot,
          entryPath,
          electronPath: options.electronPath ?? process.env.AWRIT_ELECTRON,
          overwrite: true,
          waitMs: options.waitMs,
          waitSelector: options.waitSelector,
        });
        pngBuffer = fs.readFileSync(tempShot);
      } finally {
        try {
          if (fs.existsSync(tempShot)) fs.unlinkSync(tempShot);
        } catch {}
      }
      isAdb = false;
      resolvedTarget = resolvePresentationTarget(targetUrl as string).url;
      captureOrigin = { kind: 'headless' };
    }
  }

  const source = !isAdb && resolvedTarget === targetUrl ? requestedSource : undefined;
  return persistCapture(pngBuffer, resolvedTarget, isAdb, options, id, source, captureOrigin, inputSize);
}

/** Finalize the visible viewer frame without opening or recapturing its target. */
export function finalizeViewerCapture(
  png: Uint8Array,
  source: { target: string; isAdb: boolean },
): CollaborativeCapture {
  if (!(png instanceof Uint8Array) || png.byteLength > 16 * 1024 * 1024) {
    throw new Error('Viewer capture exceeds 16 MiB');
  }
  if (
    !source ||
    typeof source !== 'object' ||
    typeof source.target !== 'string' ||
    !source.target.trim() ||
    source.target.length > 8192 ||
    typeof source.isAdb !== 'boolean'
  ) {
    throw new Error('Invalid viewer capture source');
  }
  return persistCapture(Buffer.from(png), source.target, source.isAdb, { author: 'user' });
}

/** A viewer capture: the local owner first, then a remote viewer in the same window. */
async function captureViewerFrame(
  paneId: string,
  windowId: string | undefined,
  options: CreateFrozenCaptureOptions,
): Promise<unknown> {
  const wait = {
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
    ...(options.waitSelector !== undefined ? { waitSelector: options.waitSelector } : {}),
  };
  const socketPath = getSocketPath();
  if (await isSocketAlive(socketPath, 200)) {
    try {
      return await request(socketPath, 'capture:request', {
        paneId,
        ...(windowId ? { sourceWindowId: windowId } : {}),
        ...wait,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (!isLocalMiss(reason)) throw error;
    }
  }
  const remote = findRemotePane({ ...(windowId ? { windowId } : {}), paneId });
  if (!remote) throw new Error('No running Awrit viewer. Open a page first, for example: awrit show <url>');
  return request(remote.socket, 'capture:request', wait, REMOTE_TIMEOUT_MS);
}

function liveProvenance(frame: unknown): { provenance?: CaptureProvenance } {
  if (!frame || typeof frame !== 'object') return {};
  const provenance = parseCaptureProvenance(Reflect.get(frame, 'provenance'));
  return provenance ? { provenance } : {};
}

function liveInputSize(frame: unknown): { width: number; height: number } | undefined {
  if (!frame || typeof frame !== 'object') return undefined;
  const width: unknown = Reflect.get(frame, 'inputWidth');
  const height: unknown = Reflect.get(frame, 'inputHeight');
  return typeof width === 'number' && Number.isFinite(width) && width > 0 &&
    typeof height === 'number' && Number.isFinite(height) && height > 0 ? { width, height } : undefined;
}

export function persistCapture(
  pngBuffer: Buffer,
  resolvedTarget: string,
  isAdb: boolean,
  options: CreateFrozenCaptureOptions,
  id = `cap-${randomBytes(6).toString('hex')}`,
  source?: CollaborativeCapture['source'],
  captureOrigin?: CollaborativeCapture['captureOrigin'],
  inputSize?: { width: number; height: number },
): CollaborativeCapture {
  const { width, height } = parsePngDimensions(pngBuffer);
  const capturesDir = getCapturesDir();
  const sha256 = createHash('sha256').update(pngBuffer).digest('hex');

  // 4. Validate region and comment
  const region = normalizeRegionBox(options.region, width, height);
  const comment = sanitizeCaptureComment(options.comment);
  const caption = formatMarkerCaption(comment, isAdb ? `Android ${resolvedTarget}` : 'Web capture');

  const finalPngPath = path.join(capturesDir, `${id}.png`);
  const finalJsonPath = path.join(capturesDir, `${id}.json`);
  const tmpPngPath = `${finalPngPath}.${randomBytes(4).toString('hex')}.tmp`;
  const tmpJsonPath = `${finalJsonPath}.${randomBytes(4).toString('hex')}.tmp`;

  const marker = `![awrit:${caption}](${finalPngPath})`;

  const capture: CollaborativeCapture = {
    id,
    timestamp: Date.now(),
    target: resolvedTarget,
    isAdb,
    imagePath: finalPngPath,
    width,
    height,
    sha256,
    region,
    comment,
    caption,
    marker,
    author: options.author ?? 'user',
    ...(captureOrigin ? { captureOrigin } : {}),
    ...(inputSize ? { inputCoordinates: { space: 'viewer' as const, ...inputSize,
      scaleX: inputSize.width / width, scaleY: inputSize.height / height } } : {}),
    ...(source ? { source } : {}),
  };

  // 5. Atomic write with read-only finalization
  try {
    fs.writeFileSync(tmpPngPath, pngBuffer, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmpPngPath, 0o400);
    fs.renameSync(tmpPngPath, finalPngPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPngPath)) fs.unlinkSync(tmpPngPath);
    } catch {}
    throw err;
  }

  try {
    fs.writeFileSync(tmpJsonPath, JSON.stringify(capture, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    fs.chmodSync(tmpJsonPath, 0o400);
    fs.renameSync(tmpJsonPath, finalJsonPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpJsonPath)) fs.unlinkSync(tmpJsonPath);
      if (fs.existsSync(finalPngPath)) fs.unlinkSync(finalPngPath);
    } catch {}
    throw err;
  }

  // 6. Prune old captures
  pruneOldCaptures(options.pruneLimit ?? MAX_CAPTURES_STORED);

  return capture;
}

export function loadFrozenCapture(id: string): CollaborativeCapture | null {
  if (!isValidCaptureId(id)) return null;
  const jsonPath = path.join(getCapturesDir(), `${id}.json`);
  try {
    const stat = fs.lstatSync(jsonPath);
    // JSON escaping can expand a 1 MiB source snapshot by up to six times.
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) return null;
    const text = fs.readFileSync(jsonPath, 'utf8');
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) return null;
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || data.id !== id) return null;
    return data as CollaborativeCapture;
  } catch {
    return null;
  }
}

/** Replace the note on a saved capture. Image, hash and source stay untouched. */
export function updateCaptureComment(id: string, rawComment: string): CollaborativeCapture | null {
  const capture = loadFrozenCapture(id);
  if (!capture) return null;
  const comment = sanitizeCaptureComment(rawComment);
  const caption = formatMarkerCaption(comment, capture.isAdb ? `Android ${capture.target}` : 'Web capture');
  const { comment: _old, ...rest } = capture;
  const next: CollaborativeCapture = { ...rest, ...(comment ? { comment } : {}), caption, marker: `![awrit:${caption}](${capture.imagePath})` };
  return replaceCaptureMetadata(next);
}

/**
 * Keep acknowledgements with the capture rather than short-lived submission drafts.
 * Every acknowledged revision is kept per note: reverting a note to text that was
 * already sent must still count as sent.
 */
export function updateCaptureSentRevisions(id: string, revisions: Record<string, string[]>): void {
  const capture = loadFrozenCapture(id);
  if (!capture) throw new Error('Saved capture no longer exists');
  const sentRevisions: Record<string, string[]> = { ...capture.sentRevisions };
  for (const [noteId, acknowledged] of Object.entries(revisions)) {
    sentRevisions[noteId] = [...new Set([...(sentRevisions[noteId] ?? []), ...acknowledged])];
  }
  replaceCaptureMetadata({ ...capture, sentRevisions });
}

function replaceCaptureMetadata(next: CollaborativeCapture): CollaborativeCapture {
  const finalPath = path.join(getCapturesDir(), `${next.id}.json`);
  const tmpPath = `${finalPath}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmpPath, 0o400);
    fs.renameSync(tmpPath, finalPath);
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {}
    throw err;
  }
  return next;
}

export function listFrozenCaptures(limit = 20): CollaborativeCapture[] {
  const dir = getCapturesDir();
  try {
    const files = fs.readdirSync(dir);
    const jsonFiles = files.filter((f) => f.startsWith('cap-') && f.endsWith('.json'));

    const items = jsonFiles.flatMap((f) => {
      try {
        const st = fs.lstatSync(path.join(dir, f));
        return st.isFile() ? [{ file: f, mtimeMs: st.mtimeMs }] : [];
      } catch { return []; }
    });

    items.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const result: CollaborativeCapture[] = [];
    for (const item of items) {
      const id = item.file.slice(0, -5);
      const parsed = loadFrozenCapture(id);
      if (parsed) result.push(parsed);
      if (result.length >= Math.max(1, limit)) break;
    }
    return result;
  } catch {
    return [];
  }
}
