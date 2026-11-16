// Live Milestone 2 gate over real ssh lanes, no TTY.
// Usage: bun tests/remote-reattach-smoke.ts <ssh-alias> <absolute remote awrit path> [url]
// 1. Create a session, hold a pointer button down (mid-drag), then SIGKILL both
//    local ssh lanes. The owner log must report the release.
// 2. Reattach the same session: new generation, same id, a fresh frame at
//    the new client's epoch 0 even though the first client had resized.
// 3. Freeze (SIGSTOP) the control ssh lane so heartbeats stop without a close.
//    The owner must detach on its own; a later reattach must still work.
// Exits non-zero on failure.
import { spawn, spawnSync } from 'node:child_process';
import { encodeFrame, FrameDecoder } from '../src/browserOwner/protocol';
import { MediaDecoder } from '../src/remote/protocol';
import { sshArgv } from '../src/remote/sshCommand';

const [alias, runtime, url = 'https://example.com'] = process.argv.slice(2);
if (!alias || !runtime) {
  console.error('Usage: bun tests/remote-reattach-smoke.ts <ssh-alias> <remote awrit path> [url]');
  process.exit(2);
}

type Proc = ReturnType<typeof spawn>;
type Message = Record<string, unknown> & { type: string };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const all: Proc[] = [];
const fail = (why: string): never => {
  console.error(`[REMOTE REATTACH FAIL] ${why}`);
  for (const p of all) p.kill('SIGKILL');
  process.exit(1);
};
setTimeout(() => fail('timed out after 150 s'), 150_000).unref();

// Through `sh -s`: the remote login shell may not be POSIX (for example fish).
const remoteLog = () =>
  spawnSync('ssh', ['-o', 'BatchMode=yes', '-T', alias, 'sh', '-s'], {
    input: 'cat "${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"/awrit-remote/*/owner.log\n',
    encoding: 'utf8',
  }).stdout ?? '';

const send = (p: Proc, message: unknown) =>
  p.stdin?.write(encodeFrame('control', Buffer.from(JSON.stringify(message))));

/** One connection: control lane, media lane after ready, frame counter. */
async function connect(first: { create: string } | { attach: string }) {
  const control = spawn('ssh', sshArgv(alias, 'control', runtime), {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  all.push(control);
  const messages: Message[] = [];
  const decoder = new FrameDecoder();
  control.stdout?.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) messages.push(JSON.parse(frame.payload.toString()));
  });
  send(control, { type: 'hello', version: 1, build: 'remote-reattach-smoke', codecs: ['png'] });
  send(
    control,
    'create' in first
      ? { type: 'create', request: 'c1', url: first.create }
      : { type: 'attach', request: 'a1', session: first.attach },
  );
  const end = Date.now() + 40_000;
  let ready: Message | undefined;
  while (!ready && Date.now() < end) {
    const error = messages.find((m) => m.type === 'error');
    if (error) fail(`owner error: ${JSON.stringify(error)}`);
    ready = messages.find((m) => m.type === 'ready');
    await sleep(20);
  }
  if (!ready) fail('no ready');
  const session = ready!.session as string;
  const generation = ready!.generation as number;
  send(control, { type: 'viewport', epoch: 0, width: 1280, height: 720, cols: 160, rows: 45 });

  const media = spawn('ssh', sshArgv(alias, 'media', runtime), {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  all.push(media);
  let frames = 0;
  // The real client discards frames stamped with any other viewport epoch.
  let epoch = 0;
  const mediaDecoder = new MediaDecoder();
  media.stdout?.on('data', (chunk: Buffer) => {
    for (const frame of mediaDecoder.push(chunk)) {
      if (frame.meta.epoch === epoch) frames += 1;
      send(control, { type: 'credit', surface: frame.meta.surface });
    }
  });
  send(media, { type: 'media', token: ready!.token });
  const heartbeat = setInterval(() => send(control, { type: 'heartbeat' }), 2000);
  let seq = 0;
  const input = (event: unknown) =>
    send(control, { type: 'input', seq: ++seq, generation, epoch, event });
  const resize = (next: number) => {
    epoch = next;
    send(control, { type: 'viewport', epoch, width: 1024, height: 640, cols: 128, rows: 40 });
  };
  const waitFrames = async (n: number, timeout: number) => {
    const target = frames + n;
    const stop = Date.now() + timeout;
    while (frames < target && Date.now() < stop) await sleep(20);
    return frames >= target;
  };
  return { control, media, session, generation, input, resize, waitFrames, heartbeat, messages };
}

// Count, not offset: several owner logs are concatenated and others may grow.
const releases = () => remoteLog().split('released 1 held inputs').length - 1;
const releasesBefore = releases();

// 1. Kill mid-drag.
const a = await connect({ create: url });
if (!(await a.waitFrames(1, 30_000))) fail('no first frame');
// A resized session must still accept a new client that counts epochs from 0.
a.resize(2);
if (!(await a.waitFrames(1, 20_000))) fail('no frame after resize');
a.input({ kind: 'pointer', action: 'move', x: 200, y: 200 });
a.input({ kind: 'pointer', action: 'down', x: 200, y: 200, button: 'left' });
a.input({ kind: 'pointer', action: 'move', x: 260, y: 240 });
await sleep(1500);
clearInterval(a.heartbeat);
a.control.kill('SIGKILL');
a.media.kill('SIGKILL');
let released = false;
for (let i = 0; i < 20 && !released; i++) {
  await sleep(500);
  released = releases() > releasesBefore;
}
if (!released)
  fail(`owner log has no "released 1 held inputs" after the kill:\n${remoteLog().slice(-600)}`);

// 2. Reattach.
const b = await connect({ attach: a.session });
if (b.session !== a.session) fail(`session changed: ${a.session} -> ${b.session}`);
if (b.generation <= a.generation) fail(`generation did not advance: ${b.generation}`);
if (!(await b.waitFrames(1, 20_000))) fail('no epoch-0 frame after reattach');

// 3. Silent loss: freeze the control lane; heartbeats stop, the TCP link stays up.
clearInterval(b.heartbeat);
b.control.kill('SIGSTOP');
const frozenAt = Date.now();
let refused: Message | undefined;
let c: Awaited<ReturnType<typeof connect>> | undefined;
// Until the owner times out, the lease is held and attach must answer busy.
while (Date.now() - frozenAt < 20_000) {
  const probe = spawn('ssh', sshArgv(alias, 'control', runtime), {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  all.push(probe);
  const decoder = new FrameDecoder();
  const got: Message[] = [];
  probe.stdout?.on('data', (chunk: Buffer) => {
    for (const frame of decoder.push(chunk)) got.push(JSON.parse(frame.payload.toString()));
  });
  send(probe, { type: 'hello', version: 1, build: 'remote-reattach-smoke', codecs: ['png'] });
  send(probe, { type: 'attach', request: 'p1', session: a.session });
  const stop = Date.now() + 8000;
  while (!got.length && Date.now() < stop) await sleep(20);
  probe.kill();
  const answer = got[0];
  if (answer?.type === 'error' && answer.code === 'busy') {
    refused = answer;
    await sleep(1000);
    continue;
  }
  if (answer?.type === 'ready') {
    // The probe got the session but was killed; let that loss land, then reattach for real.
    await sleep(1500);
    c = await connect({ attach: a.session });
    break;
  }
  fail(`unexpected attach answer: ${JSON.stringify(answer)}`);
}
if (!c) fail('owner never detached the frozen controller');
const detachMs = Date.now() - frozenAt;
if (!(await c!.waitFrames(1, 20_000))) fail('no frame after silent-loss reattach');

clearInterval(c!.heartbeat);
send(c!.control, { type: 'stop', request: 's1' });
await sleep(1000);
for (const p of all) p.kill('SIGKILL');

console.log(
  JSON.stringify({
    session: a.session,
    generations: [a.generation, b.generation, c!.generation],
    busyWhileFrozen: Boolean(refused),
    silentLossDetachMs: detachMs,
  }),
);
console.log('[REMOTE REATTACH OK]');
process.exit(0);
