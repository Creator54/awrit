import { expect, test } from 'bun:test';
import { PassThrough, Writable } from 'node:stream';
import { FrameDecoder } from '../browserOwner/protocol';
import type { RemoteLane } from './client';
import { writeUpload } from './uploadWriter';

function fixture() {
  const frames: { kind: string; payload: Buffer }[] = [];
  const decoder = new FrameDecoder();
  let close: (reason?: string) => void = () => {};
  let kills = 0;
  const lane: RemoteLane = {
    stdin: new Writable({
      highWaterMark: 1,
      write(bytes, _encoding, done) {
        frames.push(...decoder.push(bytes));
        setImmediate(() => {
          done();
          if (frames.at(-1)?.kind === 'output' && frames.at(-1)?.payload.length === 0) close();
        });
      },
    }),
    stdout: new PassThrough(),
    onClose(listener) {
      close = listener;
    },
    kill() {
      kills++;
    },
  };
  return { lane, frames, close: (reason?: string) => close(reason), kills: () => kills };
}
test('writer obeys backpressure, skips empty chunks, splits bytes and waits for closure', async () => {
  const state = fixture();
  const payload = Buffer.alloc(200000, 42);
  await writeUpload(
    state.lane,
    'chooser',
    'token',
    (async function* () {
      yield Buffer.alloc(0);
      yield payload;
    })(),
    new AbortController().signal,
  );
  const first = state.frames[0];
  if (!first) throw new Error('No upload handshake');
  expect(JSON.parse(first.payload.toString())).toEqual({
    type: 'upload-write',
    chooser: 'chooser',
    token: 'token',
  });
  const outputs = state.frames.slice(1);
  expect(outputs.at(-1)?.payload.length).toBe(0);
  expect(
    outputs
      .slice(0, -1)
      .every((frame) => frame.payload.length > 0 && frame.payload.length <= 65536),
  ).toBe(true);
  expect(Buffer.concat(outputs.map((frame) => frame.payload))).toEqual(payload);
  expect(state.kills()).toBe(1);
});
for (const action of ['abort', 'close', 'bytes', 'error'])
  test(`writer tears down stalled transfer on ${action}`, async () => {
    const state = fixture();
    const controller = new AbortController();
    let release: () => void = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const result = writeUpload(
      state.lane,
      'chooser',
      'token',
      (async function* () {
        await stalled;
        yield Buffer.from('late');
      })(),
      controller.signal,
    );
    await new Promise((resolve) => setImmediate(resolve));
    if (action === 'abort') controller.abort();
    if (action === 'close') state.close();
    if (action === 'bytes') state.lane.stdout.emit('data', Buffer.from('unexpected'));
    if (action === 'error') state.lane.stdin.emit('error', new Error('broken'));
    await expect(result).rejects.toThrow();
    const count = state.frames.length;
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.frames).toHaveLength(count);
    expect(state.kills()).toBe(1);
  });
