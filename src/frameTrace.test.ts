import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const script = `
import { frameTrace } from ${JSON.stringify(path.join(import.meta.dir, 'frameTrace.ts'))};
const t = frameTrace.now();
frameTrace.skip('credit');
frameTrace.skip('inactive');
frameTrace.skip('destroyed');
frameTrace.skip('noPaint');
frameTrace.dirtyArea({ width: 10, height: 20 }, { width: 100, height: 100 });
await Bun.sleep(1100);
frameTrace.record('total', t);
await Bun.sleep(1100);
frameTrace.record('total', frameTrace.now());
`;

test('overlay timing flushes independently without counting content frames', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-trace-overlay-'));
  const out = path.join(dir, 'trace.jsonl');
  const result = spawnSync(process.execPath, ['-e', `
    import { frameTrace } from ${JSON.stringify(path.join(import.meta.dir, 'frameTrace.ts'))};
    await Bun.sleep(1100);
    frameTrace.record('overlay', frameTrace.now());
  `], { env: { ...process.env, AWRIT_TRACE_FRAMES: out } });
  expect(result.status).toBe(0);
  const line = JSON.parse(readFileSync(out, 'utf8').trim());
  expect(line.frames).toBe(0);
  expect(line.overlayFrames).toBe(1);
  expect(line.overlay.p50).toBeGreaterThanOrEqual(0);
});

test('sink encoding flushes without local paints and separates surfaces', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-trace-sink-'));
  const out = path.join(dir, 'trace.jsonl');
  const result = spawnSync(process.execPath, ['-e', `
    import { frameTrace } from ${JSON.stringify(path.join(import.meta.dir, 'frameTrace.ts'))};
    frameTrace.encoded('content', frameTrace.now());
    await Bun.sleep(1100);
    frameTrace.encoded('toolbar', frameTrace.now());
    await Bun.sleep(1100);
    frameTrace.encoded('toolbar', frameTrace.now());
  `], { env: { ...process.env, AWRIT_TRACE_FRAMES: out } });
  expect(result.status).toBe(0);
  const [line, next] = readFileSync(out, 'utf8').trim().split('\n').map((entry) => JSON.parse(entry));
  expect(line.frames).toBe(0);
  expect(line.sinkEncode.content.count).toBe(1);
  expect(line.sinkEncode.toolbar.count).toBe(1);
  expect(next.sinkEncode.content.count).toBe(0);
  expect(next.sinkEncode.toolbar.count).toBe(1);
});

test('writes a summary line when AWRIT_TRACE_FRAMES is set and nothing otherwise', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-trace-'));
  const out = path.join(dir, 'trace.jsonl');
  spawnSync(process.execPath, ['-e', script], { env: { ...process.env, AWRIT_TRACE_FRAMES: out } });
  const [line, next] = readFileSync(out, 'utf8').trim().split('\n').map((entry) => JSON.parse(entry));
  expect(line.frames).toBe(1);
  expect(line.dirtyArea.p50).toBe(0.02);
  expect(line.skipped).toBe(4);
  expect(line.skippedByReason).toEqual({ credit: 1, inactive: 1, destroyed: 1, noPaint: 1 });
  expect(line.total.p50).toBeGreaterThan(1000);
  expect(next.skipped).toBe(0);
  expect(next.skippedByReason).toEqual({ credit: 0, inactive: 0, destroyed: 0, noPaint: 0 });

  const env = { ...process.env };
  delete env.AWRIT_TRACE_FRAMES;
  const off = path.join(dir, 'off.jsonl');
  spawnSync(process.execPath, ['-e', script], { env });
  expect(existsSync(off)).toBe(false);
});
