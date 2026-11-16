import { describe, expect, test } from 'bun:test';
import type { AdbServerInstance, AdbStreamOptions } from '../adb/adbControl';
import type { FrameSink, FrameSubmit } from './frameSink';
import type { Viewport } from './owner';
import type { InputEvent } from './protocol';
import { androidDeviceFromUrl, androidDeviceUrl, createAndroidPane } from './androidPane';

const VIEWPORT: Viewport = {
  type: 'viewport',
  epoch: 1,
  width: 1280,
  height: 720,
  cols: 100,
  rows: 50,
};

function harness(
  options: {
    resolution?: { width: number; height: number };
    serialError?: Error;
    startError?: Error;
  } = {},
) {
  const frames: FrameSubmit[] = [];
  const sink = {
    submit: (frame: FrameSubmit) => frames.push(frame),
    grant() {},
    setEpoch() {},
    cover() {},
    dispose() {},
  } as unknown as FrameSink;
  const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
  const starts: Array<{ device: string; opts: AdbStreamOptions }> = [];
  const serials: string[] = [];
  const resizes: Array<{ width: number; height: number }> = [];
  const stops: number[] = [];
  const resolution = options.resolution ?? { width: 1080, height: 2400 };
  const instance: AdbServerInstance = {
    url: 'http://127.0.0.1:9/',
    port: 9,
    device: 'serial',
    resolution: () => resolution,
    resize: (next) => resizes.push(next),
    stop: () => stops.push(1),
  };
  const deps = {
    serialFor: async (device: string) => {
      serials.push(device);
      if (options.serialError) throw options.serialError;
      return `serial:${device}`;
    },
    start: async (device: string, opts: AdbStreamOptions) => {
      starts.push({ device, opts });
      if (options.startError) throw options.startError;
      return instance;
    },
    fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
      posts.push({
        path: new URL(String(input)).pathname,
        body: JSON.parse(String(init?.body)),
      });
      return new Response('{}');
    }) as unknown as typeof fetch,
    capture: async () => ({ ok: true, base64: Buffer.from('png').toString('base64') }),
  };
  return { frames, sink, posts, starts, serials, resizes, stops, deps };
}

const settle = () => Bun.sleep(5);

describe('android device urls', () => {
  test('roundtrips names and serials', () => {
    for (const device of [
      'emulator-5554',
      'R58M123ABC',
      '192.168.1.5:5555',
      'a@b',
      'pixel_7.prod-x',
    ]) {
      expect(androidDeviceFromUrl(androidDeviceUrl(device))).toBe(device);
    }
    expect(androidDeviceUrl('a@b')).toBe('android://a%40b');
  });

  test('rejects foreign and malformed urls', () => {
    for (const url of [
      '',
      'http://emulator-5554',
      'android://',
      'android://a/b',
      'android://a?b',
      'android://a#b',
      'android://a%zz',
      'android://a%20b',
      'android://a%',
    ]) {
      expect(() => androidDeviceFromUrl(url)).toThrow();
    }
    for (const device of ['', 'has space', 'quote"', 'x'.repeat(129)]) {
      expect(() => androidDeviceUrl(device)).toThrow();
    }
  });
});

describe('android pane', () => {
  test('starts the shared stream and forwards frames to the sink', async () => {
    const h = harness();
    const pane = createAndroidPane('Pixel', h.sink, h.deps);

    expect(await pane.status?.()).toEqual({
      url: 'android://Pixel',
      loading: true,
      target: {
        kind: 'android',
        state: 'starting',
        capabilities: { capture: true, tools: true, input: ['key', 'text', 'pointer'] },
      },
    });
    await pane.ready;
    expect(h.serials).toEqual(['Pixel']);
    const [started] = h.starts;
    expect(started?.device).toBe('serial:Pixel');
    expect(started?.opts.maxSize).toBe(1080);
    expect(started?.opts.viewport).toEqual({ width: 1280, height: 720 });

    const bitmap = Buffer.from([1, 2, 3, 4]);
    started?.opts.onFrame?.(bitmap, 2, 1);
    expect(h.frames).toEqual([
      { surface: 'content', bitmap, width: 2, height: 1, x: 0, y: 0, z: 0 },
    ]);
    expect(await pane.status?.()).toEqual({
      url: 'android://Pixel',
      loading: false,
      target: {
        kind: 'android',
        state: 'ready',
        capabilities: { capture: true, tools: true, input: ['key', 'text', 'pointer'] },
      },
    });
  });

  test('fails ready and closes when the device cannot start', async () => {
    const h = harness({ startError: new Error('no device') });
    const pane = createAndroidPane('Pixel', h.sink, h.deps);
    await expect(pane.ready).rejects.toThrow('no device');
    await settle();
    pane.input({ kind: 'key', key: 'enter' });
    await settle();
    expect(h.posts).toEqual([]);
    expect(await pane.status?.()).toEqual({
      url: 'android://Pixel',
      loading: false,
      target: {
        kind: 'android',
        state: 'closed',
        capabilities: { capture: true, tools: true, input: ['key', 'text', 'pointer'] },
      },
    });
  });

  test('maps pointer cells to device pixels and keeps gestures ordered', async () => {
    const h = harness();
    const pane = createAndroidPane('Pixel', h.sink, h.deps);
    await pane.ready;
    pane.resize(VIEWPORT);
    expect(h.resizes).toEqual([{ width: 1280, height: 720 }]);

    const pointer = (action: 'down' | 'move' | 'up', x: number, y: number): InputEvent => ({
      kind: 'pointer',
      action,
      x,
      y,
    });
    pane.input(pointer('down', 50, 25));
    pane.input(pointer('move', 99, 49));
    pane.input(pointer('up', 0, 0));
    await settle();

    expect(h.posts.map((post) => post.path)).toEqual(['/gesture', '/gesture', '/gesture']);
    const [down, move, up] = h.posts.map((post) => post.body);
    expect(down).toMatchObject({ phase: 'down', epoch: 1, seq: 1, x: 540, y: 1200 });
    expect(move).toMatchObject({ phase: 'move', epoch: 1, seq: 2, x: 1069, y: 2352 });
    expect(up).toMatchObject({ phase: 'up', epoch: 1, seq: 3, x: 0, y: 0 });
    expect(new Set(h.posts.map((post) => post.body.id)).size).toBe(1);
    pane.input(pointer('down', 5, 5));
    pane.input(pointer('up', 5, 5));
    await settle();
    expect(h.posts.at(-2)?.body).toMatchObject({ phase: 'down', epoch: 2 });
    expect(h.posts.at(-1)?.body).toMatchObject({ phase: 'up', epoch: 2 });
  });

  test('forwards a lone pointer up so a stale finger always lifts', async () => {
    const h = harness();
    const pane = createAndroidPane('Pixel', h.sink, h.deps);
    await pane.ready;
    pane.resize(VIEWPORT);
    pane.input({ kind: 'pointer', action: 'up', x: 10, y: 10 });
    await settle();
    expect(h.posts).toEqual([{ path: '/gesture', body: expect.objectContaining({ phase: 'up' }) }]);
  });

  test('coalesces waiting moves instead of growing the queue', async () => {
    const h = harness();
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const pane = createAndroidPane('Pixel', h.sink, {
      ...h.deps,
      fetch: (async (input: URL | RequestInfo, init?: RequestInit) => {
        if (first) {
          first = false;
          await blocked;
        }
        h.posts.push({
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init?.body)),
        });
        return new Response('{}');
      }) as unknown as typeof fetch,
    });
    await pane.ready;
    pane.resize(VIEWPORT);
    pane.input({ kind: 'pointer', action: 'down', x: 1, y: 1 });
    for (let step = 0; step < 50; step += 1) {
      pane.input({ kind: 'pointer', action: 'move', x: step, y: step });
    }
    release?.();
    await settle();
    expect(h.posts.length).toBeLessThanOrEqual(3);
    expect(h.posts.at(-1)?.body).toMatchObject({ phase: 'move', x: 529, y: 2352 });
  });

  test('presses mapped keys and text, never on key up', async () => {
    const h = harness();
    const pane = createAndroidPane('Pixel', h.sink, h.deps);
    await pane.ready;
    pane.input({ kind: 'key', key: 'Enter' });
    pane.input({ kind: 'key', key: 'escape' });
    pane.input({ kind: 'key', key: 'arrow_up' });
    pane.input({ kind: 'key', key: 'ArrowUp', up: true });
    pane.input({ kind: 'key', key: 'tilde' });
    pane.input({ kind: 'key', key: 'down' });
    pane.input({ kind: 'key', key: 'a' });
    pane.input({ kind: 'text', text: 'hi' });
    pane.input({ kind: 'text', text: 'é' });
    pane.input({ kind: 'wheel', x: 1, y: 1, dx: 0, dy: 3 });
    await settle();
    expect(h.posts).toEqual([
      { path: '/key', body: { keycode: 'KEYCODE_ENTER' } },
      { path: '/key', body: { keycode: 'KEYCODE_BACK' } },
      { path: '/key', body: { keycode: 'KEYCODE_DPAD_UP' } },
      { path: '/key', body: { keycode: 'KEYCODE_DPAD_DOWN' } },
      { path: '/text', body: { text: 'a' } },
      { path: '/text', body: { text: 'hi' } },
    ]);
  });

  test('runs agent tools against the control server and reports refusals', async () => {
    const h = harness();
    const pane = createAndroidPane('Pixel', h.sink, h.deps);
    expect(await pane.callTool?.('click', { x: 10, y: 20 })).toEqual({ ok: true, x: 10, y: 20 });
    expect(h.posts).toEqual([{ path: '/tap', body: { x: 10, y: 20 } }]);
    const refusing = harness();
    refusing.deps.fetch = (async () =>
      new Response('device offline', { status: 502 })) as unknown as typeof fetch;
    const other = createAndroidPane('Pixel', refusing.sink, refusing.deps);
    await expect(other.callTool?.('key', { key: 'back' })).rejects.toThrow(
      'refused /key (502): device offline',
    );
  });

  test('captures a screenshot and stops the stream on close', async () => {
    const h = harness();
    const pane = createAndroidPane('Pixel', h.sink, h.deps);
    await pane.ready;
    const shot = await pane.capture?.({});
    expect(shot).toEqual({
      png: Buffer.from('png'),
      url: 'android://Pixel',
      inputWidth: 1080,
      inputHeight: 2400,
    });
    pane.close();
    pane.close();
    expect(h.stops).toEqual([1]);
    pane.input({ kind: 'key', key: 'enter' });
    await settle();
    expect(h.posts).toEqual([]);
  });
});
