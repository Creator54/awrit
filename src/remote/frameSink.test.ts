import { describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { encodePng } from './png';
import { decodeMediaEnvelope, encodeMediaEnvelope, type MediaFrame, type Surface } from './protocol';
import {
  createFrameSink,
  type FrameEncoder,
  type FrameSinkClock,
  type FrameSubmit,
} from './frameSink';

/** Deterministic monotonic clock with manually advanced timers. */
function fakeClock() {
  let time = 0;
  let timers: { at: number; run: () => void; cancelled: boolean }[] = [];
  return {
    clock: {
      now: () => time,
      setTimer(delayMs: number, run: () => void) {
        const timer = { at: time + delayMs, run, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    } satisfies FrameSinkClock,
    advance(ms: number) {
      const target = time + ms;
      for (;;) {
        const due = timers
          .filter((timer) => !timer.cancelled && timer.at <= target)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        timers = timers.filter((timer) => timer !== due);
        time = Math.max(time, due.at);
        due.run();
      }
      time = target;
    },
  };
}

interface EncodeCall {
  bitmap: Uint8Array;
  width: number;
  height: number;
  resolve: (png: Buffer) => void;
  reject: (error: unknown) => void;
}

/** Encoder that stays pending until the test resolves it. */
function fakeEncoder() {
  const calls: EncodeCall[] = [];
  const encode: FrameEncoder = (input) =>
    new Promise<Buffer>((resolve, reject) => {
      calls.push({ ...input, resolve, reject });
    });
  return { calls, encode };
}

function png(pixel: number): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, pixel, pixel]);
}

function frame(surface: Surface, value: number, width = 1, height = 1): FrameSubmit {
  return {
    surface,
    bitmap: new Uint8Array(width * height * 4).fill(value),
    width,
    height,
    x: 12,
    y: 34,
    z: 0,
  };
}

/** Let the encoder promise chain settle. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function createFixture() {
  const { clock, advance } = fakeClock();
  const encoder = fakeEncoder();
  const sent: MediaFrame[] = [];
  const covers: [Surface, boolean][] = [];
  const errors: unknown[] = [];
  const sink = createFrameSink((media) => sent.push(media), {
    session: 's1',
    generation: 3,
    clock,
    encode: encoder.encode,
    cover: (surface, covered) => covers.push([surface, covered]),
    onError: (error) => errors.push(error),
  });
  return { advance, clock, encoder, sent, covers, errors, sink };
}

describe('createFrameSink', () => {
  test('keeps only the newest frame without credit and encodes once after a grant', async () => {
    const fixture = createFixture();
    fixture.sink.submit(frame('content', 1));
    expect(fixture.encoder.calls.length).toBe(1);
    fixture.encoder.calls[0].resolve(png(1));
    await flush();
    expect(fixture.sent.length).toBe(1);

    // The single credit is spent until the client grants it back.
    fixture.sink.submit(frame('content', 2));
    fixture.sink.submit(frame('content', 3));
    expect(fixture.encoder.calls.length).toBe(1);

    fixture.advance(33);
    fixture.sink.grant('content');
    fixture.sink.grant('content');
    expect(fixture.encoder.calls.length).toBe(2);
    expect(fixture.encoder.calls[1].bitmap[0]).toBe(3);
    fixture.encoder.calls[1].resolve(png(3));
    await flush();
    expect(fixture.sent.map((media) => media.meta.frame)).toEqual([1, 2]);
    for (const media of fixture.sent) expect(media.meta.codec).toBe('png');
  });

  test('an epoch change drops the pending and in-flight frames', async () => {
    const fixture = createFixture();
    fixture.sink.submit(frame('content', 1));
    fixture.sink.submit(frame('content', 2));
    fixture.sink.setEpoch(1);
    fixture.encoder.calls[0].resolve(png(1));
    await flush();
    expect(fixture.sent).toEqual([]);
    fixture.sink.grant('content');
    expect(fixture.encoder.calls.length).toBe(1);

    fixture.sink.submit(frame('content', 3));
    expect(fixture.encoder.calls.length).toBe(2);
    fixture.encoder.calls[1].resolve(png(3));
    await flush();
    expect(fixture.sent.length).toBe(1);
    expect(fixture.sent[0].meta.epoch).toBe(1);
  });

  test('defers a frame submitted less than 33 ms after the last send', async () => {
    const fixture = createFixture();
    fixture.sink.submit(frame('content', 1));
    fixture.encoder.calls[0].resolve(png(1));
    await flush();
    expect(fixture.sent.length).toBe(1);

    fixture.advance(10);
    fixture.sink.grant('content');
    fixture.sink.submit(frame('content', 2));
    expect(fixture.encoder.calls.length).toBe(1);

    fixture.advance(22);
    expect(fixture.encoder.calls.length).toBe(1);
    fixture.advance(1);
    expect(fixture.encoder.calls.length).toBe(2);
  });

  test('sends protocol media frames with geometry and dimensions', async () => {
    const fixture = createFixture();
    fixture.sink.setEpoch(4);
    fixture.sink.submit(frame('toolbar', 9, 2, 1));
    fixture.encoder.calls[0].resolve(png(9));
    await flush();
    expect(fixture.sent[0]).toEqual({
      meta: {
        session: 's1',
        surface: 'toolbar',
        generation: 3,
        epoch: 4,
        frame: 1,
        codec: 'png',
        width: 2,
        height: 1,
        x: 12,
        y: 34,
        z: 0,
      },
      payload: png(9),
    });
    const [decoded] = decodeMediaEnvelope(
      encodeMediaEnvelope(fixture.sent[0].meta, fixture.sent[0].payload),
    );
    expect(decoded).toEqual(fixture.sent[0]);
  });

  test('reports cover/uncover and drops the pending covered frame', async () => {
    const fixture = createFixture();
    fixture.sink.submit(frame('content', 1));
    fixture.encoder.calls[0].resolve(png(1));
    await flush();
    fixture.sink.submit(frame('content', 2));
    fixture.sink.cover('content', true);
    expect(fixture.covers).toEqual([['content', true]]);
    fixture.sink.grant('content');
    expect(fixture.encoder.calls.length).toBe(1);
    fixture.sink.cover('content', false);
    expect(fixture.covers).toEqual([
      ['content', true],
      ['content', false],
    ]);
  });

  test('drops an in-flight encode when the surface is covered', async () => {
    const fixture = createFixture();
    fixture.sink.submit(frame('content', 1));
    expect(fixture.encoder.calls.length).toBe(1);
    fixture.sink.cover('content', true);
    fixture.encoder.calls[0].resolve(png(1));
    await flush();
    expect(fixture.sent).toEqual([]);

    // The dropped encode returns its credit; uncovering resumes the surface.
    fixture.sink.cover('content', false);
    fixture.sink.submit(frame('content', 2));
    expect(fixture.encoder.calls.length).toBe(2);
    fixture.encoder.calls[1].resolve(png(2));
    await flush();
    expect(fixture.sent.map((media) => media.meta.frame)).toEqual([1]);
  });

  test('rejects bitmaps that do not match their dimensions or protocol caps', () => {
    const fixture = createFixture();
    expect(() => fixture.sink.submit({ ...frame('content', 1), width: 2 })).toThrow();
    expect(() => fixture.sink.submit(frame('content', 1, 4097, 1))).toThrow();
    expect(() => fixture.sink.submit(frame('content', 1, 4096, 4096))).toThrow();
  });

  test('dispose cancels deferred work and ignores late encodes', async () => {
    const fixture = createFixture();
    fixture.sink.submit(frame('content', 1));
    fixture.encoder.calls[0].resolve(png(1));
    await flush();
    fixture.advance(10);
    fixture.sink.grant('content');
    fixture.sink.submit(frame('content', 2));
    fixture.sink.dispose();
    fixture.advance(100);
    expect(fixture.encoder.calls.length).toBe(1);

    fixture.sink.submit(frame('content', 3));
    expect(fixture.encoder.calls.length).toBe(1);
  });

  test('encodes in the compiled bundle without a sibling worker file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'awrit-frame-sink-'));
    try {
      const outdir = join(dir, 'dist');
      const build = await Bun.build({
        entrypoints: [join(import.meta.dir, 'frameSink.ts')],
        outdir,
        target: 'node',
        format: 'cjs',
      });
      expect(build.success).toBe(true);
      const compiledPath = join(outdir, 'frameSink.js');
      expect(await readFile(compiledPath, 'utf8')).not.toContain('pngWorker');

      const { createFrameSink: createCompiledSink } = (await import(
        pathToFileURL(compiledPath).href
      )) as { createFrameSink: typeof createFrameSink };
      const sent: MediaFrame[] = [];
      const sink = createCompiledSink((media) => sent.push(media), { session: 's1' });
      try {
        sink.submit(frame('content', 42, 2, 1));
        for (let attempt = 0; attempt < 200 && sent.length === 0; attempt++) await Bun.sleep(5);
        expect(sent.length).toBe(1);
        const media = sent[0];
        expect(media.meta).toMatchObject({ codec: 'png', width: 2, height: 1, epoch: 0, frame: 1 });
        const bitmap = new Uint8Array(2 * 1 * 4).fill(42);
        expect(media.payload).toEqual(encodePng(bitmap, 2, 1));
      } finally {
        sink.dispose();
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
