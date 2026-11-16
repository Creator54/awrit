// Live remote smoke over real ssh lanes, no TTY.
// Usage: bun tests/remote-smoke.ts <ssh-alias> <absolute remote awrit path> [url] [WxH]
// Measures time to ready and first frame, wheel-to-frame latency (includes
// link RTT), fps under continuous scrolling, and how long frames keep arriving
// after input stops (drain). Exits non-zero on failure.
import { spawn } from 'node:child_process';
import { encodeFrame, FrameDecoder } from '../src/browserOwner/protocol';
import { MediaDecoder } from '../src/remote/protocol';
import { sshArgv } from '../src/remote/sshCommand';

const [alias, runtime, url = 'https://example.com', size = '1280x720'] = process.argv.slice(2);
const [width, height] = size.split('x').map(Number);
if (!alias || !runtime || !width || !height) {
  console.error('Usage: bun tests/remote-smoke.ts <ssh-alias> <remote awrit path> [url] [WxH]');
  process.exit(2);
}

const t0 = performance.now();
const now = () => performance.now() - t0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const lanes: ReturnType<typeof spawn>[] = [];
const lane = (channel: 'control' | 'media') => {
  const p = spawn('ssh', sshArgv(alias, channel, runtime), { stdio: ['pipe', 'pipe', 'inherit'] });
  lanes.push(p);
  return p;
};
const send = (p: ReturnType<typeof spawn>, message: unknown) =>
  p.stdin?.write(encodeFrame('control', Buffer.from(JSON.stringify(message))));
const fail = (why: string): never => {
  console.error(`[REMOTE SMOKE FAIL] ${why}`);
  for (const p of lanes) p.kill();
  process.exit(1);
};
const pct = (xs: number[], p: number) =>
  Math.round([...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]);

setTimeout(() => fail('timed out after 90 s'), 90_000).unref();

const control = lane('control');
let ready: { generation: number; token: string; at: number } | undefined;
const controlDecoder = new FrameDecoder();
control.stdout?.on('data', (chunk: Buffer) => {
  for (const frame of controlDecoder.push(chunk)) {
    const m = JSON.parse(frame.payload.toString());
    if (m.type === 'error') fail(`owner error: ${JSON.stringify(m)}`);
    if (m.type === 'ready') ready = { generation: m.generation, token: m.token, at: now() };
  }
});
control.on('exit', (code) => {
  if (!stopping) fail(`control lane exited ${code}`);
});
let stopping = false;

send(control, { type: 'hello', version: 1, build: 'remote-smoke', codecs: ['png'] });
send(control, { type: 'create', request: 'r1', url });
while (!ready) await sleep(10);
const { generation, token } = ready;
send(control, {
  type: 'viewport',
  epoch: 0,
  width,
  height,
  cols: Math.round(width / 8),
  rows: Math.round(height / 16),
});

const frameTimes: number[] = [];
let bytes = 0;
const media = lane('media');
const mediaDecoder = new MediaDecoder();
media.stdout?.on('data', (chunk: Buffer) => {
  for (const frame of mediaDecoder.push(chunk)) {
    frameTimes.push(now());
    bytes += frame.payload.length;
    send(control, { type: 'credit', surface: frame.meta.surface });
  }
});
send(media, { type: 'media', token });

let seq = 0;
const wheel = (dy: number) =>
  send(control, {
    type: 'input',
    seq: ++seq,
    generation,
    epoch: 0,
    event: { kind: 'wheel', x: width / 2, y: height / 2, dx: 0, dy },
  });
const waitFrameAfter = async (t: number, timeout: number) => {
  const end = now() + timeout;
  while (now() < end) {
    const hit = frameTimes.find((f) => f > t);
    if (hit !== undefined) return hit;
    await sleep(2);
  }
  return undefined;
};
// Bounded: pages with animation never go fully quiet.
const waitQuiet = async (ms: number) => {
  const end = now() + 3000;
  while (now() < end && now() - (frameTimes.at(-1) ?? 0) < ms) await sleep(20);
};

const first = await waitFrameAfter(0, 30_000);
if (first === undefined) fail('no first frame');
await waitQuiet(500);

// Each sample starts from an idle page so no frame is already in flight.
const latencies: number[] = [];
for (let i = 0; i < 20; i++) {
  const sent = now();
  wheel(i % 2 ? -120 : 120);
  const got = await waitFrameAfter(sent, 3000);
  if (got !== undefined) latencies.push(got - sent);
  await waitQuiet(400);
}
if (latencies.length < 15) fail(`only ${latencies.length}/20 wheels produced a frame`);

const burstStart = now();
const before = frameTimes.length;
const bytesBefore = bytes;
while (now() - burstStart < 5000) {
  wheel(60);
  await sleep(50);
}
const burstEnd = now();
const burstFrames = frameTimes.length - before;
const fps = burstFrames / ((burstEnd - burstStart) / 1000);
// Drain: the last frame after input stops, minus the stop time (includes RTT).
await sleep(2000);
const drainMs = Math.max(0, (frameTimes.findLast((f) => f > burstEnd) ?? burstEnd) - burstEnd);

stopping = true;
send(control, { type: 'stop', request: 'r2' });
await sleep(1000);
for (const p of lanes) p.kill();

console.log(
  JSON.stringify({
    size,
    readyMs: Math.round(ready.at),
    firstFrameMs: Math.round(first!),
    wheelToFrameMs: { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95), n: latencies.length },
    scrollFps: Math.round(fps * 10) / 10,
    scrollKBps: Math.round((bytes - bytesBefore) / 1024 / 5),
    drainMs: Math.round(drainMs),
  }),
);
if (fps < 1) fail(`scroll fps ${fps.toFixed(1)} below 1`);
console.log('[REMOTE SMOKE OK]');
process.exit(0);
