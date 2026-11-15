import type { EngineInterface, Register, RenderElement, RenderInput } from 'claude-code';
import {
  extractVideoPayload,
  fitCellDimensions as fitVideoDimensions,
  formatTime,
  isSafePath as isSafeVideoPath,
  parseVideoReceipt,
  playheadSegment,
  segmentTargetFrame,
  trackSegmentWidths,
  pause as pauseVideo,
  toolText as videoToolText,
  type PlayerState,
  type VideoMarkerPayload,
} from './video';

interface ImageCacheEntry {
  base64: string;
  width: number;
  height: number;
  mtimeMs: number;
}

const MAX_CACHE_ENTRIES = 16;
const imageCache = new Map<string, ImageCacheEntry>();

const SENSITIVE_PATH_PATTERNS = [
  /(?:^|\/)\.(?:ssh|gnupg|aws)(?:\/|$)/,
  /(?:^|\/)\.env(?:$|\.)/,
  /(?:id_rsa|id_ed25519|id_ecdsa)(?:$|\.)/,
  /(?:^|\/)(?:credentials|secrets)(?:\.json|\.yaml|\.yml)?$/,
  /^\/(?:proc|sys|dev|etc\/shadow|etc\/passwd)/,
];

function isSafePngPath(filePath: string): boolean {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.length > 1024) {
    return false;
  }
  if (!filePath.startsWith('/')) {
    return false;
  }
  if (!filePath.toLowerCase().endsWith('.png')) {
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

function parsePngHeader(base64: string): { width: number; height: number } | null {
  try {
    const raw = atob(base64.slice(0, 48));
    if (raw.length < 24) {
      return null;
    }
    const b = new Uint8Array(24);
    for (let i = 0; i < 24; i++) {
      b[i] = raw.charCodeAt(i);
    }
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      b[0] !== 0x89 ||
      b[1] !== 0x50 ||
      b[2] !== 0x4e ||
      b[3] !== 0x47 ||
      b[4] !== 0x0d ||
      b[5] !== 0x0a ||
      b[6] !== 0x1a ||
      b[7] !== 0x0a
    ) {
      return null;
    }
    // IHDR chunk: 49 48 44 52
    if (
      b[12] !== 0x49 ||
      b[13] !== 0x48 ||
      b[14] !== 0x44 ||
      b[15] !== 0x52
    ) {
      return null;
    }
    const view = new DataView(b.buffer);
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    if (width === 0 || height === 0) {
      return null;
    }
    return { width, height };
  } catch {
    return null;
  }
}

// Standalone marker line: ![awrit:caption](/absolute/path.png)
const MARKER_REGEX = /^!\[awrit:([^\]]*)\]\((\/[^\s\)\r\n]+\.png)\)[ \t]*$/m;

interface PaneFrame {
  base64: string;
  dims: { width: number; height: number };
  target?: string;
  status: string;
}

interface PaneTools {
  process: { run(argv: string[]): Promise<{ exitCode: number; stdout: string }> };
  fs: { read(path: string, opts: { as: 'bytes' }): Promise<string | { base64: string }> };
}

// Returns a fresh frame, or an error status string. Never throws.
async function capturePaneFrame($: PaneTools, target?: string): Promise<PaneFrame | string> {
  try {
    if (target) {
      const res = await $.process.run(['awrit', 'device', 'screenshot', target, '--json']);
      if (res.exitCode !== 0) return 'Capture failed';
      const data = JSON.parse(res.stdout);
      const base64 = typeof data.base64 === 'string' ? data.base64 : '';
      const dims = parsePngHeader(base64);
      if (!dims) return 'Error capturing';
      return {
        base64,
        dims,
        target,
        status: `Live (${dims.width}x${dims.height})`,
      };
    }
    const res = await $.process.run(['awrit', 'capture', '--json']);
    if (res.exitCode !== 0) return 'Capture failed';
    const data = JSON.parse(res.stdout);
    const readRes = await $.fs.read(data.imagePath, { as: 'bytes' });
    const width = data.width || 1080;
    const height = data.height || 1920;
    return {
      base64: typeof readRes === 'string' ? readRes : readRes.base64,
      dims: { width, height },
      target: data.isAdb && typeof data.target === 'string' ? data.target : undefined,
      status: `Live (${width}x${height})`,
    };
  } catch {
    return 'Error capturing';
  }
}

const PANE_KEYS = [
  { key: 'btn-pane-back', label: '◀ Back', keycode: '4' },
  { key: 'btn-pane-home', label: '● Home', keycode: '3' },
  { key: 'btn-pane-recents', label: '■ Recents', keycode: '187' },
];

const CAPTURE_TOOL = 'mcp__awrit-chat__awrit_capture';

// Tool output arrives as a string or as content blocks with `text`.
function toolText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (!Array.isArray(output)) return '';
  return output.map((b) => (b && typeof b === 'object' && 'text' in b ? String(b.text) : '')).join('\n');
}

// Optional review notes the model passes with a capture: what changed and QA lines.
interface CaptureView {
  text?: string;
  layout?: 'side' | 'stacked';
  changes: string[];
  summary: { label: string; ok: boolean; passed?: number; total?: number }[];
}
const VIEW_PREFIX = 'awrit-view:';
const WIDE_ENOUGH = 110;
const SIDE = 38;

const clip = (v: unknown, n: number) => String(v ?? '').replace(/[\x00-\x1F\x7F]/g, ' ').trim().slice(0, n);
// Free text from the model keeps its line breaks but loses other control characters.
const clipText = (v: string, n: number) => v.replace(/[\x00-\x09\x0B-\x1F\x7F]/g, ' ').trim().slice(0, n);
const MAX_TEXT = 800;

// Bounds untrusted model input before it is serialized into the result.
function cleanView(input: unknown): CaptureView | null {
  if (!input || typeof input !== 'object') return null;
  const obj = input as { changes?: unknown; summary?: unknown; text?: unknown; layout?: unknown };
  const text = typeof obj.text === 'string' ? clipText(obj.text, MAX_TEXT) : '';
  const layout = obj.layout === 'side' || obj.layout === 'stacked' ? obj.layout : undefined;
  const changes = (Array.isArray(obj.changes) ? obj.changes : [])
    .slice(0, 6)
    .filter((c): c is string => typeof c === 'string')
    .map((c) => clip(c, 80))
    .filter(Boolean);
  const summary = (Array.isArray(obj.summary) ? obj.summary : []).slice(0, 3).flatMap((r) => {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return [];
    const row = r as Record<string, unknown>;
    if (typeof row.label !== 'string') return [];
    const label = clip(row.label, 60);
    if (!label) return [];
    if (typeof row.ok !== 'boolean') return [];
    const hasPassed = row.passed !== undefined;
    const hasTotal = row.total !== undefined;
    let passed: number | undefined;
    let total: number | undefined;
    if (hasPassed || hasTotal) {
      if (!hasPassed || !hasTotal) return [];
      if (
        typeof row.passed !== 'number' ||
        typeof row.total !== 'number' ||
        !Number.isSafeInteger(row.passed) ||
        !Number.isSafeInteger(row.total) ||
        row.passed < 0 ||
        row.total < 0 ||
        row.passed > row.total
      ) {
        return [];
      }
      passed = row.passed;
      total = row.total;
    }
    const ok = row.ok === true && (total === undefined || passed === total);
    return [{ label, ok, passed, total }];
  });
  return changes.length || summary.length || text
    ? { ...(text ? { text } : {}), ...(layout ? { layout } : {}), changes, summary }
    : null;
}

function splitView(text: string): { text: string; view: CaptureView | null } {
  const lines = text.split('\n');
  const remaining: string[] = [];
  let view: CaptureView | null = null;
  for (const line of lines) {
    if (line.startsWith(VIEW_PREFIX)) {
      if (!view) {
        try {
          view = cleanView(JSON.parse(line.slice(VIEW_PREFIX.length)));
        } catch {}
      }
    } else {
      remaining.push(line);
    }
  }
  return { text: remaining.join('\n'), view };
}

type Ui = ReturnType<EngineInterface['ui']['resolve']>;

// Text, changes and QA the model wrote about the media; drawn beside it on wide terminals, above it otherwise.
function viewPanel({ Box, Markdown, Text }: Ui, view: CaptureView, side: boolean) {
  return Box({
    flexDirection: 'column',
    width: side ? SIDE : undefined,
    flexShrink: 0,
    children: [
      ...(view.text ? [Markdown({ text: view.text })] : []),
      ...(view.changes.length
        ? [Text({ bold: true, dimColor: true, children: 'WHAT CHANGED' }), ...view.changes.map((c) => Text({ children: `\u2022 ${c}` }))]
        : []),
      ...(view.summary.length
        ? [
            Text({ bold: true, dimColor: true, children: 'QA (agent-reported)' }),
            ...view.summary.map((r) =>
              Text({
                children: `${r.ok ? '\u2713' : '\u2717'} ${r.label}${r.total !== undefined ? ` (${r.passed ?? 0}/${r.total})` : ''}`,
              }),
            ),
          ]
        : []),
    ],
  });
}

// Caps rows to available height minus controls and shrinks columns proportionally to keep aspect.
function fitCellDimensions(
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

// Shared by the /awrit-capture row and the awrit_capture tool result: text with its marker drawn as an image.
async function renderCaptureText(
  $: EngineInterface,
  e: RenderInput,
  text: string,
  next: () => RenderElement | Promise<RenderElement>,
): Promise<RenderElement> {
  if (e.surface !== 'terminal') return next();
  const split = splitView(text);
  text = split.text;
  const match = text.match(MARKER_REGEX);
  if (!match?.[2] || !isSafePngPath(match[2])) return next();
  try {
    const stat = await $.fs.stat(match[2], { resolve: true });
    if (stat.kind !== 'file' || stat.size <= 0 || stat.size > 16 * 1024 * 1024) return next();
    if (stat.isLink && typeof stat.realPath !== 'string') return next();
    const filePath = typeof stat.realPath === 'string' ? stat.realPath : match[2];
    if (typeof stat.realPath === 'string' && !isSafePngPath(stat.realPath)) return next();
    const read = await $.fs.read(filePath, { as: 'bytes' });
    const base64 = typeof read === 'string' ? read : (typeof read === 'object' && read !== null && 'base64' in read && typeof read.base64 === 'string') ? read.base64 : null;
    if (!base64) return next();
    const dims = parsePngHeader(base64);
    if (!dims) return next();
    const { Box, Button, Image, Markdown, Text } = $.ui.resolve(e);
    const file = filePath;
    const available = e.viewport?.columns ?? 80;
    const availableRows = e.viewport?.rows ?? 40;
    const sideBySide = split.view !== null && split.view.layout !== 'stacked' && available >= WIDE_ENOUGH;
    const maxCols = sideBySide
      ? Math.max(1, Math.min(60, available - SIDE - 4))
      : Math.max(1, Math.min(100, available - 4));
    const maxRows = Math.max(1, Math.min(255, availableRows - 8));
    const { cols, rows } = fitCellDimensions(dims.width, dims.height, maxCols, maxRows);
    const rest = text.replace(MARKER_REGEX, '').trim();
    const view = split.view;
    const sidebar = view ? viewPanel($.ui.resolve(e), view, sideBySide) : null;
    const picture = Image({ key: `awrit-capture-${e.requestId}`, source: { png: base64 }, columns: cols, rows, alt: match[1] || 'capture' });
    return Box({
      flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', paddingX: 1,
      children: [
        ...(rest ? [Markdown({ text: rest })] : []),
        Text({ bold: true, children: match[1] || 'Capture' }),
        Text({ dimColor: true, children: `${dims.width}×${dims.height} · screenshot` }),
        ...(sidebar && sideBySide ? [Box({ flexDirection: 'row', gap: 2, alignItems: 'flex-start', children: [sidebar, picture] })] : [...(sidebar ? [sidebar] : []), picture]),
        Box({
          flexDirection: 'row',
          gap: 2,
          children: [
            Button({
              key: `open-${e.requestId}`,
              label: '↗ Open',
              plain: true,
              dimColor: true,
              onPress: async () => {
                try {
                  let cmd = 'xdg-open';
                  const ostype = await $.env.get('OSTYPE');
                  if (typeof ostype === 'string' && ostype.toLowerCase().includes('darwin')) {
                    cmd = 'open';
                  } else {
                    const uname = await $.process.run(['uname', '-s']);
                    if (uname.exitCode === 0 && uname.stdout.trim() === 'Darwin') cmd = 'open';
                  }
                  const res = await $.process.run([cmd, file]);
                  if (res.exitCode !== 0) $.ui.toast('Could not open image');
                } catch {
                  $.ui.toast('Could not open image');
                }
              },
            }),
            Button({
              key: `copy-${e.requestId}`,
              label: '⧉ Copy path',
              plain: true,
              dimColor: true,
              onPress: (press) =>
                void $.ui.copy({ text: file, surface: press.surface }).then((r) => $.ui.toast(r.isCopied ? 'Path copied' : 'Could not copy the path')),
            }),
          ],
        }),
      ],
    });
  } catch {
    return next();
  }
}

const MAX_PLAYER_STATES = 32;
const playerStates = new Map<string, PlayerState>();
const freshCalls = new Set<string>();
let activePlayingRequestId: string | null = null;

function pausePlayer(state: PlayerState): void {
  pauseVideo(state);
  if (activePlayingRequestId === state.requestId) {
    activePlayingRequestId = null;
  }
}

function playVideo(state: PlayerState, $: EngineInterface): void {
  if (state.expired) return;
  if (state.currentFrame >= state.data.count) {
    state.currentFrame = 1;
  }
  if (activePlayingRequestId && activePlayingRequestId !== state.requestId) {
    const other = playerStates.get(activePlayingRequestId);
    if (other) pausePlayer(other);
  }
  activePlayingRequestId = state.requestId;
  state.isPlaying = true;
  const currentNonce = ++state.nonce;
  const intervalMs = Math.max(16, Math.round(1000 / (state.data.fps || 10)));

  state.timer = $.clock.every(intervalMs, async () => {
    if (state.nonce !== currentNonce || !state.isPlaying) return;
    if (state.pendingBlit) {
      return;
    }
    if (state.currentFrame >= state.data.count) {
      pausePlayer(state);
      $.ui.invalidate('ui.render');
      return;
    }
    const nextFrame = state.currentFrame + 1;
    const framePath = `${state.data.dir}/f${String(nextFrame).padStart(5, '0')}.png`;
    const pending = $.ui.blit({
      requestId: state.requestId,
      key: `video-frame-${state.requestId}`,
      source: { file: framePath, format: 'png', generation: nextFrame },
      columns: state.mountedColumns,
      rows: state.mountedRows,
    });
    state.pendingBlit = pending.then(() => {}, () => {});
    const completion = state.pendingBlit;
    try {
      const res = await pending;
      if (state.nonce !== currentNonce || !state.isPlaying) {
        return;
      }
      if (res && 'deny' in res && res.deny) {
        $.ui.log(`Video blit denied: ${res.deny}`, { to: 'debug' });
        pausePlayer(state);
        return;
      }
      state.currentFrame = nextFrame;
      const currentSec = Math.floor(state.currentFrame / state.data.fps);
      if (currentSec !== state.lastInvalidateSec) {
        state.lastInvalidateSec = currentSec;
        $.ui.invalidate('ui.render');
      }
    } catch (err) {
      if (state.nonce !== currentNonce) return;
      $.ui.log(`Video blit failed: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' });
      pausePlayer(state);
    } finally {
      if (state.pendingBlit === completion) state.pendingBlit = null;
    }
  });
}

function seekVideo(state: PlayerState, targetFrame: number, $: EngineInterface): void {
  if (state.expired) return;
  const frame = Math.max(1, Math.min(state.data.count, targetFrame));
  const wasPlaying = state.isPlaying;
  state.timer?.cancel();
  state.timer = null;
  const seekNonce = ++state.nonce;
  state.currentFrame = frame;
  state.lastInvalidateSec = Math.floor(frame / state.data.fps);
  const framePath = `${state.data.dir}/f${String(frame).padStart(5, '0')}.png`;
  const previous = state.pendingBlit;
  const pending = (previous ?? Promise.resolve()).then(async () => {
    if (state.nonce !== seekNonce || state.expired) return;
    return $.ui.blit({
      requestId: state.requestId,
      key: `video-frame-${state.requestId}`,
      source: { file: framePath, format: 'png', generation: frame },
      columns: state.mountedColumns,
      rows: state.mountedRows,
    });
  }).then((res) => {
    if (state.nonce !== seekNonce || state.expired) return;
    if (res && 'deny' in res && res.deny) {
      $.ui.log(`Video blit denied on seek: ${res.deny}`, { to: 'debug' });
      pausePlayer(state);
    } else if (wasPlaying && state.isPlaying && frame < state.data.count) {
      playVideo(state, $);
    } else if (frame >= state.data.count) {
      pausePlayer(state);
    }
    $.ui.invalidate('ui.render');
  }).catch((err) => {
    if (state.nonce !== seekNonce) return;
    $.ui.log(`Video seek blit error: ${err}`, { to: 'debug' });
    pausePlayer(state);
    $.ui.invalidate('ui.render');
  });
  state.pendingBlit = pending;
  void pending.finally(() => {
    if (state.pendingBlit === pending) state.pendingBlit = null;
  });
  $.ui.invalidate('ui.render');
}

async function renderVideoText(
  $: EngineInterface,
  e: RenderInput,
  text: string,
  next: () => RenderElement | Promise<RenderElement>,
): Promise<RenderElement> {
  if (e.surface !== 'terminal') return next();
  const split = splitView(text);
  const { payload, rest } = extractVideoPayload(split.text);
  if (!payload) return next();
  const view = split.view;

  let state = playerStates.get(e.requestId);
  if (!state || state.data.id !== payload.id) {
    if (playerStates.size >= MAX_PLAYER_STATES) {
      const oldest = playerStates.keys().next().value;
      if (oldest) {
        const s = playerStates.get(oldest);
        if (s) pausePlayer(s);
        playerStates.delete(oldest);
      }
    }
    state = {
      requestId: e.requestId,
      data: payload,
      currentFrame: 1,
      isPlaying: false,
      timer: null,
      nonce: 0,
      pendingBlit: null,
      lastInvalidateSec: 0,
      mountedColumns: 80,
      mountedRows: 24,
      hasAutoPlayed: false,
      expired: false,
    };
    playerStates.set(e.requestId, state);
  }

  if (e.props && typeof e.props === 'object' && 'onScreen' in e.props && (e.props as { onScreen?: unknown }).onScreen === null) {
    if (state.isPlaying) {
      pausePlayer(state);
    }
  }

  if (!state.hasAutoPlayed && freshCalls.has(payload.id)) {
    state.hasAutoPlayed = true;
    freshCalls.delete(payload.id);
    $.clock.after(100, () => {
      playVideo(state!, $);
    });
  }

  const availableCols = Math.max(1, e.viewport?.columns ?? 80);
  const availableRows = Math.max(1, e.viewport?.rows ?? 40);
  const sideBySide = view !== null && view.layout !== 'stacked' && availableCols >= WIDE_ENOUGH;
  const maxCols = sideBySide ? Math.max(1, Math.min(70, availableCols - SIDE - 8)) : Math.min(72, Math.max(1, availableCols - 4));
  const maxRows = Math.max(1, Math.min(255, availableRows - 11));
  const { cols: imgCols, rows: imgRows } = fitVideoDimensions(payload.width, payload.height, maxCols, maxRows);
  state.mountedColumns = imgCols;
  state.mountedRows = imgRows;

  const currentFramePath = `${payload.dir}/f${String(state.currentFrame).padStart(5, '0')}.png`;
  const { Box, Button, Image, Markdown, Text } = $.ui.resolve(e);

  const imageElement = Image({
    key: `video-frame-${e.requestId}`,
    source: {
      file: currentFramePath,
      format: 'png',
      generation: state.currentFrame,
    },
    columns: imgCols,
    rows: imgRows,
    alt: payload.caption || `video ${payload.id}`,
  });

  const isEnded = state.currentFrame >= payload.count;
  const playLabel = state.isPlaying ? '❚❚' : isEnded ? '↺' : '▶';

  const playBtn = Button({
    key: `video-play-${e.requestId}`,
    label: playLabel,
    plain: true,
    onPress: () => {
      if (state!.isPlaying) {
        pausePlayer(state!);
        $.ui.invalidate('ui.render');
      } else {
        playVideo(state!, $);
        $.ui.invalidate('ui.render');
      }
    },
  });

  const stepBackBtn = Button({
    key: `video-back5-${e.requestId}`,
    label: '‹ 5s',
    plain: true,
    onPress: () => {
      const step = Math.max(1, Math.round(5 * payload.fps));
      seekVideo(state!, Math.max(1, state!.currentFrame - step), $);
    },
  });

  const stepFwdBtn = Button({
    key: `video-fwd5-${e.requestId}`,
    label: '5s ›',
    plain: true,
    onPress: () => {
      const step = Math.max(1, Math.round(5 * payload.fps));
      seekVideo(state!, Math.min(payload.count, state!.currentFrame + step), $);
    },
  });

  const currentSec = (state.currentFrame - 1) / payload.fps;
  const totalSec = payload.duration;
  const timeLabel = `${formatTime(currentSec)} / ${formatTime(totalSec)}`;
  const timeText = Text({ children: timeLabel, dimColor: true });

  const openBtn = Button({
    key: `video-open-${e.requestId}`,
    label: '↗ Open',
    plain: true,
    dimColor: true,
    onPress: async () => {
      try {
        let cmd = 'xdg-open';
        const ostype = await $.env.get('OSTYPE');
        if (typeof ostype === 'string' && ostype.toLowerCase().includes('darwin')) {
          cmd = 'open';
        } else {
          const uname = await $.process.run(['uname', '-s']);
          if (uname.exitCode === 0 && uname.stdout.trim() === 'Darwin') cmd = 'open';
        }
        const res = await $.process.run([cmd, payload.source]);
        if (res.exitCode !== 0) $.ui.toast('Could not open video');
      } catch {
        $.ui.toast('Could not open video');
      }
    },
  });

  const copyBtn = Button({
    key: `video-copy-${e.requestId}`,
    label: '⧉ Copy path',
    plain: true,
    dimColor: true,
    onPress: (press) =>
      void $.ui.copy({ text: payload.source, surface: press.surface }).then((r) =>
        $.ui.toast(r.isCopied ? 'Path copied' : 'Could not copy the path'),
      ),
  });

  const timeWidth = 5;
  const playWidth = 2;
  const inline = imgCols >= 36;
  const trackWidth = inline ? imgCols - playWidth - 2 * timeWidth - 3 : imgCols;
  const widths = trackSegmentWidths(trackWidth);
  const head = playheadSegment(state.currentFrame, payload.count, widths.length);
  const seekButtons = widths.map((w, i) =>
    // The keyed Box is the hover scope. Plain buttons invert their whole label on hover,
    // which blocks out a multi-cell stretch of the bar; tint it instead.
    Box({
      key: `video-seekbox-${e.requestId}-${i}`,
      children: [
        Button({
          key: `video-seek-${e.requestId}-${i}`,
          label:
            i === head
              ? i === 0
                ? '\u25cf' + '\u2500'.repeat(w - 1)
                : '\u2501'.repeat(w - 1) + '\u25cf'
              : (i < head ? '\u2501' : '\u2500').repeat(w),
          plain: true,
          // Unplayed stretch is dimmed so played vs unplayed reads at a glance.
          dimColor: i > head,
          hover: { inverse: false, color: 'suggestion' },
          onPress: () => seekVideo(state!, segmentTargetFrame(i, widths.length, payload.count), $),
        }),
      ],
    }),
  );
  const track = Box({ flexDirection: 'row', gap: 0, children: seekButtons });
  const elapsed = Text({ children: formatTime(currentSec).padStart(timeWidth), dimColor: true });
  const total = Text({ children: formatTime(totalSec).padStart(timeWidth), dimColor: true });
  const playSlot = Box({ width: playWidth, children: [playBtn] });
  const transport = inline
    ? Box({ flexDirection: 'row', gap: 1, children: [playSlot, elapsed, track, total] })
    : Box({ flexDirection: 'column', gap: 0, children: [Box({ flexDirection: 'row', gap: 1, children: [playSlot, timeText] }), track] });
  const actions = Box({
    flexDirection: imgCols < 32 ? 'column' : 'row', gap: imgCols < 32 ? 0 : 2,
    children: [stepBackBtn, stepFwdBtn, openBtn, copyBtn],
  });
  const restMarkdown = rest && !/^Video loaded \([^\n]*\)[.:]?$/.test(rest) ? Markdown({ text: rest }) : null;
  const media = Box({ flexDirection: 'column', children: [imageElement, Box({ flexDirection: 'column', width: imgCols, children: [transport, actions] })] });
  const panel = view ? viewPanel($.ui.resolve(e), view, sideBySide) : null;
  const body = sideBySide && panel
    ? Box({ flexDirection: 'row', gap: 2, alignItems: 'flex-start', children: [panel, media] })
    : Box({ flexDirection: 'column', children: [...(panel ? [panel] : []), media] });
  const card = Box({
    flexDirection: 'column', borderStyle: 'round', borderColor: 'subtle', paddingX: 1,
    children: [
      Text({ bold: true, children: payload.caption || 'Recorded video' }),
      Text({ dimColor: true, children: `${payload.width}\u00d7${payload.height} \u00b7 ${formatTime(totalSec)} \u00b7 recorded` }),
      body,
    ],
  });
  return Box({ flexDirection: 'column', children: [...(restMarkdown ? [restMarkdown] : []), card] });
}

// Shared by awrit_capture and awrit_video: rejects malformed text, layout, changes and summary.
function invalidViewInput(input: Record<string, unknown>): string | null {
  if (input.text !== undefined && typeof input.text !== 'string') return 'Invalid text';
  if (input.layout !== undefined && input.layout !== 'side' && input.layout !== 'stacked') return 'Invalid layout';
  if (input.changes !== undefined) {
    if (!Array.isArray(input.changes) || input.changes.some((c) => typeof c !== 'string' || /[\x00-\x1F\x7F]/.test(c))) {
      return 'Invalid changes';
    }
  }
  if (input.summary !== undefined) {
    if (!Array.isArray(input.summary)) return 'Invalid summary';
    for (const item of input.summary) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return 'Invalid summary';
      const row = item as Record<string, unknown>;
      for (const k of Object.keys(row)) {
        if (!['label', 'ok', 'passed', 'total'].includes(k)) return `Unexpected field in summary item: ${k}`;
      }
      if (typeof row.label !== 'string' || !row.label.trim() || /[\x00-\x1F\x7F]/.test(row.label) || typeof row.ok !== 'boolean') {
        return 'Invalid summary item';
      }
      const hasPassed = row.passed !== undefined;
      const hasTotal = row.total !== undefined;
      if (hasPassed !== hasTotal) return 'Unpaired summary counts';
      if (hasPassed && (typeof row.passed !== 'number' || typeof row.total !== 'number' || !Number.isSafeInteger(row.passed) || !Number.isSafeInteger(row.total) || row.passed < 0 || row.total < 0 || row.passed > row.total)) {
        return 'Invalid summary counts';
      }
      if (row.ok === true && typeof row.passed === 'number' && typeof row.total === 'number' && row.passed < row.total) {
        return 'Summary item cannot be ok when passed is less than total';
      }
    }
  }
  return null;
}

export const register: Register = async (on) => {
  // Register native browser tools (snapshot, click, type, navigate, url, scroll)

  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'awrit_capture',
      description:
        "Show the user a screenshot of an Android device or web page in chat. Use unasked after visual changes or checks. " +
        '`target` (URL/file); omit it only when exactly one Android device is connected. For a named device run `awrit device screenshot NAME`. The user sees the image; you do not get it back.',
      inputSchema: {
        type: 'object',
        properties: {
          target: { type: 'string', description: 'URL or local HTML file, instead of a device' },
          comment: { type: 'string', description: 'Short caption' },
          text: { type: 'string', description: 'Explanation, markdown, max ~800 chars. Left of the media on wide terminals, above on narrow.' },
          layout: { type: 'string', enum: ['side', 'stacked'], description: 'side (default) = text left on wide terminals; stacked = text above' },
          changes: { type: 'array', items: { type: 'string' }, description: 'Real changes only, few words each, max 6' },
          summary: {
            type: 'array',
            description: 'Checks you really ran, max 3; omit if none',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, ok: { type: 'boolean' }, passed: { type: 'number' }, total: { type: 'number' } },
              required: ['label', 'ok'],
            },
          },
        },
      },
      isDeferred: false,
    });
    await $.command.register({ name: 'awrit-pane', description: 'Open the Awrit visual workspace; use close to dismiss it' });
    await $.command.register({ name: 'awrit-overlay', description: 'Toggle the Awrit visual overlay over chat; close or status' });
    await $.command.register({ name: 'awrit-capture', description: 'Capture an immutable frozen screenshot with optional note' });
    await $.tool.register({
      name: 'awrit_video',
      description:
        'Play a recorded video (e.g. screen recording) in chat with play/pause/seek. ' +
        '`path` is an absolute file path; `caption` is optional.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path to the video' },
          caption: { type: 'string', description: 'Short caption' },
          text: { type: 'string', description: 'Explanation, markdown, max ~800 chars. Left of the video on wide terminals, above on narrow.' },
          layout: { type: 'string', enum: ['side', 'stacked'], description: 'side (default) = text left on wide terminals; stacked = text above' },
          changes: { type: 'array', items: { type: 'string' }, description: 'Real changes only, few words each, max 6' },
          summary: {
            type: 'array',
            description: 'Checks you really ran, max 3; omit if none',
            items: {
              type: 'object',
              properties: { label: { type: 'string' }, ok: { type: 'boolean' }, passed: { type: 'number' }, total: { type: 'number' } },
              required: ['label', 'ok'],
            },
          },
        },
        required: ['path'],
      },
      isDeferred: false,
    });
    await $.command.register({
      name: 'awrit-video',
      description: 'Display a recorded video with playback controls; usage: /awrit-video PATH [caption]',
    });
    return next(e);
  });

  on('command.run', { command: 'awrit-overlay' }, async ($, e) => {
    const rawArgs = e.args.trim();
    const launcher = 'awrit';
    const cmdArgs = ['overlay'];
    if (rawArgs === 'close') cmdArgs.push('close');
    else if (rawArgs === 'status') cmdArgs.push('status');
    else if (rawArgs) cmdArgs.push(rawArgs);
    cmdArgs.push('--json');

    try {
      const res = await $.process.run([launcher, ...cmdArgs]);
      if (res.exitCode !== 0) {
        return { text: `awrit-overlay error: ${res.stderr || res.stdout || 'command failed'}` };
      }
      const data = JSON.parse(res.stdout);
      if (data.action === 'opened') {
        const viewer = data.viewerRunning
          ? 'viewer running'
          : 'viewer process not detected yet, it may still be starting';
        return { text: `${data.resumed ? 'Resumed' : 'Opened'} overlay for ${data.target} (window ${data.id}, ${viewer}). Press Escape to return to chat.` };
      }
      if (data.action === 'already-open') {
        return { text: `Overlay for ${data.target} is already open (window ${data.id}).` };
      }
      if (data.action === 'closed') {
        return { text: `Closed overlay (window ${data.previousId}). Chat focus restored.` };
      }
      if (data.action === 'already-closed') {
        return { text: 'Overlay is already closed.' };
      }
      if (data.action === 'status') {
        return { text: data.open ? `Overlay is open for ${data.target} (window ${data.id}).` : 'Overlay is closed.' };
      }
      return { text: JSON.stringify(data) };
    } catch (err) {
      return { text: `Failed to execute overlay command: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  on('command.run', { command: 'awrit-capture' }, async ($, e) => {
    const rawArgs = e.args.trim();
    const launcher = 'awrit';
    const cmdArgs = ['capture'];
    if (rawArgs) {
      cmdArgs.push('--comment', rawArgs);
    }
    cmdArgs.push('--json');

    try {
      const res = await $.process.run([launcher, ...cmdArgs]);
      if (res.exitCode !== 0) {
        return { text: `awrit-capture error: ${res.stderr || res.stdout || 'capture failed'}` };
      }
      const data = JSON.parse(res.stdout);
      return {
        text: `Captured ${data.width}x${data.height} image (${data.id}):\n${data.marker}`,
      };
    } catch (err) {
      return { text: `Failed to execute capture command: ${err instanceof Error ? err.message : String(err)}` };
    }
  });

  on('command.run', { command: 'awrit-video' }, async ($, e) => {
    const trimmed = e.args.trim();
    if (!trimmed) {
      return { text: 'Usage: /awrit-video PATH [caption]' };
    }
    let path = '';
    let caption = '';
    if (trimmed.startsWith('"')) {
      const endQuote = trimmed.indexOf('"', 1);
      if (endQuote !== -1) {
        path = trimmed.slice(1, endQuote);
        caption = trimmed.slice(endQuote + 1).trim();
      } else {
        path = trimmed.slice(1);
      }
    } else {
      const spaceIdx = trimmed.search(/\s/);
      if (spaceIdx === -1) {
        path = trimmed;
      } else {
        path = trimmed.slice(0, spaceIdx);
        caption = trimmed.slice(spaceIdx + 1).trim();
      }
    }

    if (path.startsWith('-')) {
      return { text: 'Invalid video path: options not supported' };
    }
    if (path.includes('://')) {
      return { text: 'Invalid video path: URLs not supported' };
    }
    if (!path.startsWith('/')) {
      return { text: 'Invalid video path: must be an absolute path' };
    }
    if (/[\x00-\x1F\x7F]/.test(path)) {
      return { text: 'Invalid video path: control characters not allowed' };
    }
    if (!isSafeVideoPath(path)) {
      return { text: 'Invalid video path: unsafe path rejected' };
    }
    if (caption && /[\x00-\x1F\x7F]/.test(caption)) {
      return { text: 'Invalid caption: control characters not allowed' };
    }

    try {
      const res = await $.process.run(['awrit', 'video', '--json', '--', path], { timeoutMs: 120000 });
      if (res.exitCode !== 0) {
        let err = 'command failed';
        try {
          const parsed = JSON.parse(res.stdout);
          if (parsed && typeof parsed.error === 'string') err = parsed.error;
          else if (res.stderr) err = res.stderr.trim();
          else if (res.stdout) err = res.stdout.trim();
        } catch {
          if (res.stderr) err = res.stderr.trim();
          else if (res.stdout) err = res.stdout.trim();
        }
        return { text: `awrit-video error: ${err}` };
      }

      const parsed = JSON.parse(res.stdout);
      const receipt = parseVideoReceipt(parsed);
      if (!receipt) {
        return { text: 'awrit-video error: invalid video receipt returned' };
      }

      let stat;
      try {
        stat = await $.fs.stat(receipt.poster, { resolve: true });
      } catch {
        return { text: 'awrit-video error: poster frame missing or invalid' };
      }
      if (stat.kind !== 'file' || stat.size <= 0) {
        return { text: 'awrit-video error: poster frame missing or invalid' };
      }

      const payload: VideoMarkerPayload = {
        ...receipt,
        ...(caption ? { caption } : {}),
      };

      freshCalls.add(receipt.id);
      return {
        text: `Video loaded (${receipt.width}x${receipt.height}, ${receipt.count} frames, ${receipt.duration}s):\nawrit-video:${JSON.stringify(payload)}`,
      };
    } catch (err) {
      return { text: `awrit-video error: ${err instanceof Error ? err.message : String(err)}` };
    }
  });


  // Pane state: stores latest captured PNG base64 and dimensions
  let paneImageBase64: string | null = null;
  let paneImageDims = { width: 1080, height: 1920 };
  let paneDeviceTarget: string | undefined;
  let paneStatusText = 'Ready';

  const applyFrame = (frame: PaneFrame | string) => {
    if (typeof frame === 'string') {
      paneStatusText = frame;
      return;
    }
    paneImageBase64 = frame.base64;
    paneImageDims = frame.dims;
    paneDeviceTarget = frame.target;
    paneStatusText = frame.status;
  };

  on('command.run', { command: 'awrit-pane' }, async ($, e) => {
    if (e.args.trim() === 'close') {
      await $.ui.close({ id: 'awrit-workspace' });
      return { text: 'Awrit workspace close requested. Devices are unchanged.' };
    }
    const arg = e.args.trim();
    if (arg && arg !== 'refresh') {
      // Same serial rule as the kitten: no option-like or shell-significant values.
      if (!/^[A-Za-z0-9._:-]{1,128}$/.test(arg) || arg.startsWith('-')) {
        return { text: 'Usage: /awrit-pane [SERIAL|refresh|close]' };
      }
      paneDeviceTarget = arg;
    }
    if (!paneImageBase64 || arg) {
      paneStatusText = 'Capturing...';
      applyFrame(await capturePaneFrame($, paneDeviceTarget));
    }
    const result = await $.ui.open({ id: 'awrit-workspace', title: 'Awrit Device' });
    return {
      text: result.isPlaced
        ? 'Awrit visual workspace opened beside chat. Use buttons to navigate.'
        : `Awrit workspace opened: ${result.reason ?? 'placement pending'}`,
    };
  });

  on('ui.render', { component: 'Pane', requestId: 'awrit-workspace' }, ($, e) => {
    if (e.surface !== 'terminal') {
      const { Box, Text, Button } = $.ui.resolve(e);
      return Box({
        children: [
          Text({ children: 'Awrit workspace is available on terminal surface.' }),
          Button({ key: 'close-workspace', label: 'Close', onPress: () => $.ui.close({ id: 'awrit-workspace' }) }),
        ],
      });
    }

    const { Box, Text, Button, Image } = $.ui.resolve(e);
    const bodyCols = Math.max(1, e.props.bodyColumns || 40);
    const bodyRows = Math.max(1, e.props.scroll?.bodyRows || 30);

    const maxCols = Math.min(bodyCols - 2, 50);
    const maxRows = Math.max(1, bodyRows - 8);
    const { cols: imgCols, rows: imgRows } = fitCellDimensions(paneImageDims.width, paneImageDims.height, maxCols, maxRows);

    const imageElement = paneImageBase64
      ? Image({
          key: 'pane-device-screen',
          source: { png: paneImageBase64 },
          columns: Math.max(1, imgCols),
          rows: Math.max(1, imgRows),
          alt: 'Live device screen',
        })
      : Text({ children: 'No frame captured yet. Press [Refresh] below.' });

    return Box({
      flexDirection: 'column',
      gap: 1,
      children: [
        Box({
          flexDirection: 'row',
          gap: 1,
          children: [
            Text({ bold: true, children: '📱 Awrit Android' }),
            Text({ dimColor: true, children: `[${paneStatusText}]` }),
          ],
        }),
        Box({
          alignItems: 'center',
          justifyContent: 'center',
          children: [imageElement],
        }),
        Box({
          flexDirection: 'row',
          gap: 1,
          children: [
            Button({
              key: 'btn-pane-refresh',
              label: '🔄 Refresh',
              onPress: async () => applyFrame(await capturePaneFrame($, paneDeviceTarget)),
            }),
            ...PANE_KEYS.map(({ key, label, keycode }) =>
              Button({
                key,
                label,
                onPress: async () => {
                  if (!paneDeviceTarget) {
                    paneStatusText = 'No Android device selected';
                    return;
                  }
                  try {
                    await $.process.run(['adb', '-s', paneDeviceTarget, 'shell', 'input', 'keyevent', keycode]);
                  } catch {
                    paneStatusText = 'Key event failed';
                    return;
                  }
                  applyFrame(await capturePaneFrame($, paneDeviceTarget));
                },
              }),
            ),
            Button({
              key: 'close-workspace',
              label: '✕ Close',
              onPress: () => $.ui.close({ id: 'awrit-workspace' }),
            }),
          ],
        }),
      ],
    });
  });

  // /awrit-capture prints a command row; render its marker as an image there too.
  on('ui.render', { component: 'CommandOutput', props: { command: 'awrit-capture' } }, ($, e, next) =>
    e.surface !== 'terminal' ? next(e) : renderCaptureText($, e, e.props.text, () => next(e)),
  );

  // The model calls this tool unprompted; no Bash step to remember. Same CLI underneath.
  on('tool.call', { tool: /^mcp__awrit-chat__awrit_capture$/ }, async ($, e) => {
    const input = e as Record<string, unknown>;
    // Only declared tool properties are read below; the event envelope carries host-defined
    // keys (prompt_id, permission_mode, agent_id, ...) that must not be rejected.
    if (input.adb !== undefined) {
      return { deny: '`adb` was replaced by: awrit device view NAME' };
    }
    let target: string | undefined;
    if (input.target !== undefined) {
      if (typeof input.target !== 'string' || input.target.length === 0 || input.target.startsWith('-') || /[\x00-\x1F\x7F]/.test(input.target)) {
        return { deny: 'Invalid target' };
      }
      target = input.target;
    }
    let comment: string | undefined;
    if (input.comment !== undefined) {
      if (typeof input.comment !== 'string' || /[\x00-\x1F\x7F]/.test(input.comment)) {
        return { deny: 'Invalid comment' };
      }
      comment = input.comment;
    }
    const invalid = invalidViewInput(input);
    if (invalid) return { deny: invalid };
    const args = ['capture'];
    if (target !== undefined) args.push(target);
    if (comment !== undefined) args.push('--comment', comment);
    args.push('--json');
    const res = await $.process.run(['awrit', ...args]);
    if (res.exitCode !== 0) {
      let err = 'unknown error';
      try {
        const parsed = JSON.parse(res.stdout);
        if (parsed && typeof parsed.error === 'string') err = parsed.error;
        else if (res.stderr) err = res.stderr.trim();
        else if (res.stdout) err = res.stdout.trim();
      } catch {
        if (res.stderr) err = res.stderr.trim();
        else if (res.stdout) err = res.stdout.trim();
      }
      return { deny: `awrit capture failed (exit code ${res.exitCode}): ${err}` };
    }
    try {
      const data = JSON.parse(res.stdout);
      if (!data || typeof data !== 'object') return { deny: 'Invalid capture receipt' };
      const { width, height, id, marker } = data;
      if (typeof width !== 'number' || typeof height !== 'number' || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || width > 16384 || height <= 0 || height > 16384) {
        return { deny: 'Invalid capture dimensions' };
      }
      if (typeof id !== 'string' || !/^cap-[a-f0-9]{12}$/.test(id)) return { deny: 'Invalid capture id' };
      if (typeof marker !== 'string') return { deny: 'Missing capture marker' };
      const trimmedMarker = marker.trim();
      const m = trimmedMarker.match(MARKER_REGEX);
      if (!m || m[0] !== trimmedMarker || !m[2] || !isSafePngPath(m[2])) return { deny: 'Invalid capture marker path' };
      if (data.caption !== undefined && (typeof data.caption !== 'string' || /[\x00-\x1F\x7F]/.test(data.caption))) {
        return { deny: 'Invalid caption' };
      }
      if (data.imagePath !== undefined && (!isSafePngPath(String(data.imagePath)) || data.imagePath !== m[2])) {
        return { deny: 'Invalid capture image path' };
      }
      const view = cleanView(input);
      const extra = view ? `\n${VIEW_PREFIX}${JSON.stringify(view)}` : '';
      return { result: `Captured; inline preview: ${width}x${height} capture (${id}).\n${marker}${extra}` };
    } catch {
      return { deny: 'awrit capture returned unreadable output' };
    }
  }).catch(() => ({ deny: 'awrit capture failed' }));

  on('tool.call', { tool: /^mcp__awrit-chat__awrit_video$/ }, async ($, e) => {
    const input = e as Record<string, unknown>;
    const ENVELOPE = new Set(['tool', 'tool_use_id', 'consent', 'agentId', 'requestMeta', 'cwd', 'session_id', 'transcript_path', 'hook_event_name']);
    const ALLOWED = new Set(['path', 'caption', 'text', 'layout', 'changes', 'summary']);
    for (const k of Object.keys(input)) {
      if (!ENVELOPE.has(k) && !ALLOWED.has(k)) return { deny: `Unexpected argument: ${k}` };
    }

    if (typeof input.path !== 'string' || !input.path) {
      return { deny: 'Missing required argument: path' };
    }
    if (input.path.startsWith('-')) {
      return { deny: 'Invalid video path: flags not allowed' };
    }
    if (input.path.includes('://')) {
      return { deny: 'Invalid video path: URLs not allowed' };
    }
    if (!input.path.startsWith('/')) {
      return { deny: 'Invalid video path: must be an absolute path' };
    }
    if (/[\x00-\x1F\x7F]/.test(input.path)) {
      return { deny: 'Invalid video path: control characters not allowed' };
    }
    if (!isSafeVideoPath(input.path)) {
      return { deny: 'Invalid video path: unsafe path rejected' };
    }
    if (input.caption !== undefined) {
      if (typeof input.caption !== 'string' || /[\x00-\x1F\x7F]/.test(input.caption)) {
        return { deny: 'Invalid caption' };
      }
    }

    const invalid = invalidViewInput(input);
    if (invalid) return { deny: invalid };

    const res = await $.process.run(['awrit', 'video', '--json', '--', input.path], { timeoutMs: 120000 });
    if (res.exitCode !== 0) {
      let err = 'unknown error';
      try {
        const parsed = JSON.parse(res.stdout);
        if (parsed && typeof parsed.error === 'string') err = parsed.error;
        else if (res.stderr) err = res.stderr.trim();
        else if (res.stdout) err = res.stdout.trim();
      } catch {
        if (res.stderr) err = res.stderr.trim();
        else if (res.stdout) err = res.stdout.trim();
      }
      return { deny: `awrit video failed (exit code ${res.exitCode}): ${err}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      return { deny: 'awrit video returned unreadable output' };
    }

    const receipt = parseVideoReceipt(parsed);
    if (!receipt) {
      return { deny: 'Invalid video receipt' };
    }

    try {
      const stat = await $.fs.stat(receipt.poster, { resolve: true });
      if (stat.kind !== 'file' || stat.size <= 0) {
        return { deny: 'Poster frame missing or invalid' };
      }
    } catch {
      return { deny: 'Cannot verify video poster frame' };
    }

    const payload: VideoMarkerPayload = {
      ...receipt,
      ...(typeof input.caption === 'string' && input.caption.trim() ? { caption: input.caption.trim() } : {}),
    };

    freshCalls.add(receipt.id);
    const toolUseId = input.tool_use_id;
    if (typeof toolUseId === 'string') {
      freshCalls.add(toolUseId);
    }

    const view = cleanView(input);
    const extra = view ? `\n${VIEW_PREFIX}${JSON.stringify(view)}` : '';
    return {
      result: `Video loaded (${receipt.width}x${receipt.height}, ${receipt.count} frames, ${receipt.duration}s).\nawrit-video:${JSON.stringify(payload)}${extra}`,
    };
  }).catch(() => ({ deny: 'awrit video failed' }));

  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    const props = e.props as { tool: string; output: unknown; isErrored: boolean };
    if (e.surface !== 'terminal' || props.isErrored) return next(e);
    if (props.tool === CAPTURE_TOOL) {
      return renderCaptureText($, e, toolText(props.output), () => next(e));
    }
    if (props.tool === 'mcp__awrit-chat__awrit_video' || /^mcp__.*__awrit_video$/.test(props.tool)) {
      return renderVideoText($, e, videoToolText(props.output), () => next(e));
    }
    return next(e);
  });

  on('ui.render', { component: 'CommandOutput', props: { command: 'awrit-video' } }, ($, e, next) =>
    e.surface !== 'terminal' ? next(e) : renderVideoText($, e, e.props.text, () => next(e)),
  );

  // Instruct assistant on explicit marker syntax and bounded PNG workflow
  on('prompt.compose', async ($, e, next) => {
    const res = await next(e);
    const instructionSection = {
      id: 'awrit-chat:instructions',
      scope: 'session' as const,
      // Shared guidance (feedback key, browsing preference) comes from the SessionStart hook
      // `awrit context --claude`, installed by `awrit setup` with this plugin; only plugin-specific lines live here.
      text: [
        '# awrit-chat: visual tools',
        '/awrit-pane opens a side pane for the user; do not claim it is open unless they opened it.',
      ].join('\n'),
    };

    return {
      sections: [...res.sections, instructionSection],
    };
  });

  // Render inline image for AssistantMessage in terminal
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    // Terminal surface only; preserve desktop and other surfaces as host defaults
    if (e.surface !== 'terminal') {
      return next(e);
    }

    const originalText = e.props?.text;
    if (typeof originalText !== 'string' || originalText.length === 0) {
      return next(e);
    }

    if (originalText.includes('awrit-video:')) {
      return renderVideoText($, e, originalText, () => next(e));
    }

    // Match explicit standalone marker line
    const markerMatch = originalText.match(MARKER_REGEX);
    if (!markerMatch || !markerMatch[2]) {
      return next(e);
    }

    const caption = markerMatch[1]?.trim() ?? '';
    const filePath = markerMatch[2].trim();

    if (!isSafePngPath(filePath)) {
      // Security / validation failure: fallback to host unchanged
      return next(e);
    }

    let cached = imageCache.get(filePath);
    try {
      const stat = await $.fs.stat(filePath, { resolve: true });
      if (stat.kind !== 'file' || stat.size <= 0 || stat.size > 16 * 1024 * 1024) {
        $.ui.log('PNG stat rejected; preserving original reply', { to: 'debug' });
        return next(e);
      }
      if (stat.isLink && typeof stat.realPath !== 'string') {
        $.ui.log('PNG link without realPath rejected; preserving original reply', { to: 'debug' });
        return next(e);
      }
      if (typeof stat.realPath === 'string' && !isSafePngPath(stat.realPath)) {
        $.ui.log('PNG realPath rejected; preserving original reply', { to: 'debug' });
        return next(e);
      }
      const targetPath = typeof stat.realPath === 'string' ? stat.realPath : filePath;

      if (!cached || cached.mtimeMs !== stat.mtimeMs) {
        const readResult = await $.fs.read(targetPath, { as: 'bytes' });
        const base64 = typeof readResult === 'string' ? readResult : (typeof readResult === 'object' && readResult !== null && 'base64' in readResult && typeof readResult.base64 === 'string') ? readResult.base64 : null;
        if (!base64) {
          $.ui.log('PNG bytes empty; preserving original reply', { to: 'debug' });
          return next(e);
        }
        const dims = parsePngHeader(base64);
        if (!dims) {
          $.ui.log('PNG header rejected; preserving original reply', { to: 'debug' });
          return next(e);
        }

        cached = {
          base64,
          width: dims.width,
          height: dims.height,
          mtimeMs: stat.mtimeMs,
        };

        if (imageCache.size >= MAX_CACHE_ENTRIES) {
          const oldest = imageCache.keys().next().value;
          if (oldest) imageCache.delete(oldest);
        }
        imageCache.set(filePath, cached);
        if (targetPath !== filePath) imageCache.set(targetPath, cached);
      }
    } catch {
      $.ui.log('Image file could not be read; preserving original reply', { to: 'debug' });
      return next(e);
    }

    if (!cached) {
      return next(e);
    }

    // Clean text by removing the explicit marker line while preserving paragraph breaks
    const cleanText = originalText.replace(MARKER_REGEX, '').replace(/^\n+|\n+$/g, '');

    const { Box, Image, Markdown } = $.ui.resolve(e);
    // Host engine nodes cannot be nested beneath width-constrained boxes.
    const hostNode = cleanText.length > 0 ? Markdown({ text: cleanText }) : null;

    // Calculate dimensions within 1..255 using verified columns field
    const availableCols = Math.max(1, e.viewport?.columns ?? 80);
    const availableRows = Math.max(1, e.viewport?.rows ?? 40);
    const isNarrow = availableCols < 70;

    const maxCols = isNarrow
      ? Math.min(255, Math.max(1, Math.min(availableCols, 60)))
      : Math.min(255, Math.max(1, Math.min(Math.floor(availableCols * 0.45), 50)));
    const maxRows = Math.max(1, Math.min(255, availableRows - 4));
    const { cols: imgCols, rows: imgRows } = fitCellDimensions(cached.width, cached.height, maxCols, maxRows);

    const imageElement = Image({
      key: `awrit-chat-img-${e.requestId}`,
      source: { png: cached.base64 },
      columns: imgCols,
      rows: imgRows,
      alt: caption || 'awrit screenshot',
    });

    if (!hostNode) {
      return Box({
        children: [imageElement],
      });
    }

    return Box({
      flexDirection: isNarrow ? 'column' : 'row',
      alignItems: 'flex-start',
      gap: isNarrow ? 1 : 2,
      width: availableCols,
      children: isNarrow
        ? [hostNode, imageElement]
        : [
            Box({ width: availableCols - imgCols - 2, flexShrink: 0, children: [hostNode] }),
            Box({ width: imgCols, flexShrink: 0, children: [imageElement] }),
          ],
    });
  });

  on('session.end', async ($, e, next) => {
    for (const state of playerStates.values()) {
      pausePlayer(state);
    }
    playerStates.clear();
    freshCalls.clear();
    activePlayingRequestId = null;
    return next(e);
  });
};
