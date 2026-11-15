import { appendFileSync } from 'node:fs';

type Stage = 'toBitmap' | 'write' | 'emit' | 'total' | 'ack' | 'dirtyArea' | 'overlay';

const file = process.env.AWRIT_TRACE_FRAMES;
const sinkEncode: Record<'content' | 'toolbar', number[]> = { content: [], toolbar: [] };
const samples: Record<Stage, number[]> = { toBitmap: [], write: [], emit: [], total: [], ack: [], dirtyArea: [], overlay: [] };
type SkipReason = 'inactive' | 'destroyed' | 'noPaint' | 'credit';
const skippedByReason: Record<SkipReason, number> = { inactive: 0, destroyed: 0, noPaint: 0, credit: 0 };
let skipped = 0;
let lastFlush = performance.now();

function percentile(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0;
}

function flush(now: number) {
  if (!file) return;
  const out: Record<string, unknown> = { t: Math.round(now), frames: samples.total.length, overlayFrames: samples.overlay.length, skipped, skippedByReason, dirtyAreaUnit: 'fraction of bitmap area; local animated path only' };
  for (const [stage, values] of Object.entries(samples)) {
    const sorted = values.slice().sort((a, b) => a - b);
    out[stage] = {
      p50: +percentile(sorted, 0.5).toFixed(3),
      p95: +percentile(sorted, 0.95).toFixed(3),
      max: +(sorted.at(-1) ?? 0).toFixed(3),
    };
    values.length = 0;
  }
  out.sinkEncode = Object.fromEntries(Object.entries(sinkEncode).map(([surface, values]) => {
    const sorted = values.slice().sort((a, b) => a - b);
    const summary = { count: values.length, p50: +percentile(sorted, 0.5).toFixed(3), p95: +percentile(sorted, 0.95).toFixed(3), max: +(sorted.at(-1) ?? 0).toFixed(3) };
    values.length = 0;
    return [surface, summary];
  }));
  skipped = 0;
  lastFlush = now;
  try {
    appendFileSync(file, `${JSON.stringify(out)}\n`);
  } catch {
    // Tracing is best effort and must never affect painting.
  }
  for (const reason of Object.keys(skippedByReason) as SkipReason[]) skippedByReason[reason] = 0;
}

/** Frame timing, written once a second to $AWRIT_TRACE_FRAMES. Off (one check) when unset. */
export const frameTrace = {
  enabled: Boolean(file),
  now: () => performance.now(),
  record(stage: Stage, startedAt: number) {
    if (!file) return;
    const now = performance.now();
    samples[stage].push(now - startedAt);
    if ((stage === 'total' || stage === 'overlay') && now - lastFlush >= 1000) flush(now);
  },
  /** PNG encoder completion only, not transport acknowledgement or presentation. */
  encoded(surface: 'content' | 'toolbar', startedAt: number) {
    if (!file) return;
    const now = performance.now();
    sinkEncode[surface].push(now - startedAt);
    if (now - lastFlush >= 1000) flush(now);
  },
  dirtyArea(dirty: { width: number; height: number }, size: { width: number; height: number }) {
    if (file && size.width > 0 && size.height > 0) {
      samples.dirtyArea.push(Math.max(0, Math.min(1, dirty.width * dirty.height / (size.width * size.height))));
    }
  },
  skip(reason: SkipReason) {
    if (!file) return;
    skipped++;
    skippedByReason[reason]++;
  },
};
