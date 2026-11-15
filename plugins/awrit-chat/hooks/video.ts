import type { Timer } from 'claude-code';

export interface VideoReceipt {
  id: string;
  source: string;
  dir: string;
  poster: string;
  width: number;
  height: number;
  count: number;
  fps: number;
  duration: number;
  caption?: string;
}

export type VideoMarkerPayload = VideoReceipt;

export interface PlayerState {
  requestId: string;
  data: VideoMarkerPayload;
  currentFrame: number;
  isPlaying: boolean;
  timer: Timer | null;
  nonce: number;
  pendingBlit: Promise<void> | null;
  lastInvalidateSec: number;
  mountedColumns: number;
  mountedRows: number;
  hasAutoPlayed: boolean;
  expired: boolean;
}

const SENSITIVE_PATH_PATTERNS = [
  /(?:^|\/)\.(?:ssh|gnupg|aws)(?:\/|$)/,
  /(?:^|\/)\.env(?:$|\.)/,
  /(?:id_rsa|id_ed25519|id_ecdsa)(?:$|\.)/,
  /(?:^|\/)(?:credentials|secrets)(?:\.json|\.yaml|\.yml)?$/,
  /^\/(?:proc|sys|dev|etc\/shadow|etc\/passwd)/,
];

export function isSafePath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 1024) {
    return false;
  }
  if (!filePath.startsWith('/')) {
    return false;
  }
  if (/[\x00-\x1F\x7F]/.test(filePath)) {
    return false;
  }
  if (filePath.includes('/../') || filePath.endsWith('/..') || filePath.includes('/./') || filePath.endsWith('/.')) {
    return false;
  }
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(filePath)) {
      return false;
    }
  }
  return true;
}

export function parseVideoReceipt(raw: unknown): VideoMarkerPayload | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== 'string' || !/^vid-[a-f0-9]{24}$/.test(r.id)) return null;
  if (typeof r.source !== 'string' || !isSafePath(r.source)) return null;
  if (typeof r.dir !== 'string' || !isSafePath(r.dir) || !r.dir.endsWith(`/${r.id}`)) return null;
  if (typeof r.poster !== 'string' || r.poster !== `${r.dir}/f00001.png` || !isSafePath(r.poster)) return null;
  if (typeof r.width !== 'number' || !Number.isInteger(r.width) || r.width <= 0 || r.width > 16384) return null;
  if (typeof r.height !== 'number' || !Number.isInteger(r.height) || r.height <= 0 || r.height > 16384) return null;
  if (typeof r.count !== 'number' || !Number.isInteger(r.count) || r.count < 1 || r.count > 600) return null;
  if (typeof r.fps !== 'number' || r.fps <= 0 || r.fps > 60) return null;
  if (typeof r.duration !== 'number' || r.duration <= 0 || r.duration > 60) return null;
  let caption: string | undefined;
  if (r.caption !== undefined) {
    if (typeof r.caption !== 'string' || /[\x00-\x1F\x7F]/.test(r.caption)) return null;
    caption = r.caption.slice(0, 256);
  }
  return {
    id: r.id,
    source: r.source,
    dir: r.dir,
    poster: r.poster,
    width: r.width,
    height: r.height,
    count: r.count,
    fps: r.fps,
    duration: r.duration,
    ...(caption ? { caption } : {}),
  };
}

export function toolText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return '';
  return output.map((b) => (b && typeof b === 'object' && 'text' in b ? String(b.text) : '')).join('\n');
}

export function fitCellDimensions(
  imgWidth: number,
  imgHeight: number,
  maxCols: number,
  maxRows: number,
): { cols: number; rows: number } {
  const aspect = imgWidth > 0 && imgHeight > 0 ? imgWidth / imgHeight : 1;
  const colsPerRow = aspect / 0.5;
  let cols = Math.max(1, Math.min(255, maxCols));
  let rows = Math.max(1, Math.round(cols / colsPerRow));
  if (rows > maxRows) {
    rows = Math.max(1, Math.min(255, maxRows));
    cols = Math.max(1, Math.min(maxCols, Math.round(rows * colsPerRow)));
  }
  return { cols, rows };
}

export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2, '0')}`;
}

/** Split `width` columns into up to 20 segments of near-equal size that sum to exactly `width`. */
export function trackSegmentWidths(width: number): number[] {
  const total = Math.max(1, Math.floor(width));
  const n = Math.min(20, total);
  return Array.from({ length: n }, (_, i) => Math.floor(((i + 1) * total) / n) - Math.floor((i * total) / n));
}

export function playheadSegment(frame: number, count: number, segments: number): number {
  const fraction = count > 1 ? (frame - 1) / (count - 1) : 0;
  return Math.min(segments - 1, Math.max(0, Math.floor(fraction * segments)));
}

/** Frame at the left edge of segment `i`; the first segment is frame 1 and the last is the final frame. */
export function segmentTargetFrame(i: number, segments: number, count: number): number {
  if (segments <= 1) return count;
  return Math.min(count, Math.max(1, 1 + Math.round((i / (segments - 1)) * (count - 1))));
}

export function pause(state: PlayerState): void {
  state.isPlaying = false;
  if (state.timer) {
    state.timer.cancel();
    state.timer = null;
  }
  state.nonce++;
}

export function extractVideoPayload(text: string): { payload: VideoMarkerPayload | null; rest: string } {
  const lines = text.split('\n');
  const remaining: string[] = [];
  let payload: VideoMarkerPayload | null = null;
  for (const line of lines) {
    if (line.startsWith('awrit-video:')) {
      if (!payload) {
        try {
          const raw = JSON.parse(line.slice('awrit-video:'.length));
          payload = parseVideoReceipt(raw);
        } catch {}
      }
    } else {
      remaining.push(line);
    }
  }
  return { payload, rest: remaining.join('\n').trim() };
}
