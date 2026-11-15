import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function paintFixture(noPaint: boolean, freshName = (_write: number) => true) {
  const source = readFileSync(new URL('./paint.ts', import.meta.url), 'utf8');
  // Run the real registration functions without starting Electron or a terminal.
  const functions = source.slice(source.indexOf('const weakPaintedContents_'));
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    functions.replaceAll('export function', 'function'),
  );
  const counts = { allocations: 0, bitmaps: 0, publications: 0 };
  const composites: boolean[] = [];
  const compositeRects: { width: number; height: number }[] = [];
  const compositedNames: string[] = [];
  const overlayHandlers = new Map<string, (...args: unknown[]) => void>();
  const cleanup = { listeners: 0, images: 0 };
  const transfers = { writes: 0, names: [] as string[], sizes: [] as number[] };
  const placement = (buffer: { nameBase64: string }) => {
    counts.publications++;
    transfers.names.push(buffer.nameBase64);
    return {
      free() {
        cleanup.images++;
      },
      replace() {},
      replacePlacement: placement,
    };
  };
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const context = vm.createContext({
    Buffer,
    Uint8Array,
    options: { 'no-paint': noPaint },
    rememberTabThumbnail() {},
    features: { current: {} },
    ShmGraphicBuffer: class {
      nameBase64: string;
      constructor(size: number) {
        counts.allocations++;
        transfers.sizes.push(size);
        this.nameBase64 = `buffer-${counts.allocations}`;
      }
      write() {
        transfers.writes++;
        if (freshName(transfers.writes)) this.nameBase64 = `transfer-${transfers.writes}`;
      }
    },
    getWindowSize: () => ({ cols: 10, rows: 10, width: 10, height: 10 }),
    defaultOutput: { setModes() {}, startBatch() {}, endBatch() {} },
    defaultGraphics: { paintImage: placement },
    setModes() {},
    startBatch() {},
    endBatch() {},
    Mode: { pendingUpdate: 2026 },
    frameTrace: { now: () => 0, record() {}, skip() {} },
    paintImage: placement,
    window: {
      webContents: {
        on(event: string, handler: (...args: unknown[]) => void) {
          handlers.set(event, handler);
        },
        off(event: string, handler: (...args: unknown[]) => void) {
          if (handlers.get(event) === handler) handlers.delete(event);
          cleanup.listeners++;
        },
      },
    },
    overlay: {
      webContents: {
        on(event: string, handler: (...args: unknown[]) => void) {
          overlayHandlers.set(event, handler);
        },
        off(event: string, handler: (...args: unknown[]) => void) {
          if (overlayHandlers.get(event) === handler) overlayHandlers.delete(event);
        },
      },
    },
    container: {
      paintedContent: 0,
      loadFrame(_frame: number, buffer: { nameBase64: string }) {
        transfers.names.push(buffer.nameBase64);
        counts.publications++;
        return {
          composite(rect: { width: number; height: number }, blend = false) {
            compositeRects.push({ ...rect });
            composites.push(blend);
            compositedNames.push(buffer.nameBase64);
          },
          delete() {},
        };
      },
    },
    layout: { deviceLayout: { x: 0, y: 0, width: 10, height: 10 } },
  });
  vm.runInContext(`'use strict';\n${javascript}`, context);
  const image = {
    getSize: () => ({ width: 10, height: 10 }),
    toBitmap() {
      counts.bitmaps++;
      return Buffer.alloc(400);
    },
  };
  return {
    context,
    counts,
    cleanup,
    handlers,
    overlayHandlers,
    composites,
    compositedNames,
    compositeRects,
    image,
    transfers,
  };
}

test('remote toolbar submits a surface without allocating local graphics', () => {
  const fixture = paintFixture(false);
  const frames: { surface: string; width: number; height: number; z: number }[] = [];
  fixture.context.sink = { submit: (frame: (typeof frames)[number]) => frames.push(frame) };
  vm.runInContext(
    'painted = registerPaintedContent(container, window, layout, undefined, undefined, sink, {window: overlay, layout})',
    fixture.context,
  );
  fixture.overlayHandlers.get('paint')?.({}, {}, fixture.image);
  expect(frames).toHaveLength(1);
  expect(frames[0]).toMatchObject({ surface: 'toolbar', width: 10, height: 10, z: 1 });
  expect(fixture.counts.allocations).toBe(0);
  expect(fixture.counts.publications).toBe(0);
  vm.runInContext('layout.deviceLayout.x = 2; painted.refresh()', fixture.context);
  expect(frames).toHaveLength(2);
  expect(frames[1]).toMatchObject({ surface: 'toolbar', x: 2, z: 1 });
  expect(fixture.counts.bitmaps).toBe(1);
  vm.runInContext('painted.destroy()', fixture.context);
  expect(fixture.overlayHandlers.has('paint')).toBe(false);
});

test('toolbar blends into the restored page on every update and removes its listener', async () => {
  const fixture = paintFixture(false);
  vm.runInContext(
    'painted = registerPaintedContent(container, window, layout, undefined, undefined, undefined, {window: overlay, layout})',
    fixture.context,
  );
  await fixture.handlers.get('paint')?.({}, {}, fixture.image);
  fixture.overlayHandlers.get('paint')?.({}, {}, fixture.image);
  expect(fixture.composites).toEqual([false, false, true]);
  const allocations = fixture.counts.allocations;
  fixture.overlayHandlers.get('paint')?.({}, {}, fixture.image);
  expect(fixture.counts.allocations).toBe(allocations);
  await fixture.handlers.get('paint')?.({}, {}, fixture.image);
  expect(fixture.composites.slice(-2)).toEqual([false, true]);
  vm.runInContext('painted.refresh(); painted.refresh(); painted.destroy()', fixture.context);
  expect(fixture.composites.slice(-4)).toEqual([false, true, false, true]);
  expect(fixture.overlayHandlers.size).toBe(0);
  // Kitty consumes SHM names on upload; refresh must compose loaded frames, not upload again.
  expect(new Set(fixture.transfers.names).size).toBe(fixture.transfers.names.length);
});

test('fallback reuses wrappers only while native writes publish fresh names', async () => {
  for (const [freshName, allocations, writes] of [
    [() => true, 1, 3],
    [() => false, 3, 3],
    [(write: number) => write === 1, 3, 4],
  ] as const) {
    const fixture = paintFixture(false, freshName);
    vm.runInContext(
      'registerPaintedContentFallback(window, layout, undefined, {replacePlacement:true})',
      fixture.context,
    );
    const paint = fixture.handlers.get('paint');
    if (!paint) throw new Error('Paint listener was not registered');
    for (let frame = 0; frame < 3; frame++) await paint({}, {}, fixture.image);
    expect(fixture.counts.allocations).toBe(allocations);
    expect(fixture.transfers.writes).toBe(writes);
    expect(new Set(fixture.transfers.names).size).toBe(3);
  }
});

test('fallback replacement republishes retained pixels before another paint', async () => {
  const fixture = paintFixture(false);
  vm.runInContext('painted = registerPaintedContentFallback(window, layout);', fixture.context);
  await fixture.handlers.get('paint')?.({}, {}, fixture.image);
  const publications = fixture.counts.publications;
  vm.runInContext('replacement = registerPaintedContentFallback(window, layout); painted.destroy();', fixture.context);
  expect(fixture.counts.publications).toBeGreaterThan(publications);
  expect(fixture.handlers.has('paint')).toBe(true);
});

test('fallback allocates the new size before reusing a resized buffer', async () => {
  const fixture = paintFixture(false);
  vm.runInContext(
    'registerPaintedContentFallback(window, layout, undefined, {replacePlacement:true})',
    fixture.context,
  );
  const paint = fixture.handlers.get('paint');
  if (!paint) throw new Error('Paint listener was not registered');
  await paint({}, {}, fixture.image);
  const resized = { getSize: () => ({ width: 20, height: 10 }), toBitmap: () => Buffer.alloc(800) };
  await paint({}, {}, resized);
  await paint({}, {}, resized);
  expect(fixture.transfers.sizes).toEqual([400, 800]);
  expect(new Set(fixture.transfers.names).size).toBe(3);
});

test('no-paint skips conversion, allocation and publication in both paint paths', async () => {
  for (const animation of [true, false]) {
    const fixture = paintFixture(true);
    vm.runInContext(
      animation
        ? 'registerPaintedContent(container, window, layout)'
        : 'registerPaintedContentFallback(window, layout)',
      fixture.context,
    );
    const paint = fixture.handlers.get('paint');
    expect(paint).toBeFunction();
    if (!paint) throw new Error('Paint listener was not registered');
    await paint({}, {}, fixture.image);
    expect(fixture.counts).toEqual({ allocations: 0, bitmaps: 0, publications: 0 });
  }
});

test('inactive pages cannot allocate or publish frames into the selected page', async () => {
  for (const animation of [true, false]) {
    const fixture = paintFixture(false);
    vm.runInContext(
      animation
        ? 'registerPaintedContent(container, window, layout, undefined, () => false)'
        : 'registerPaintedContentFallback(window, layout, undefined, undefined, undefined, () => false)',
      fixture.context,
    );
    const paint = fixture.handlers.get('paint');
    if (!paint) throw new Error('Paint listener was not registered');
    await paint({}, {}, fixture.image);
    expect(fixture.counts).toEqual({ allocations: 0, bitmaps: 0, publications: 0 });
  }
});

test('enabled painting still converts and publishes in both paint paths', async () => {
  for (const animation of [true, false]) {
    const fixture = paintFixture(false);
    vm.runInContext(
      animation
        ? 'registerPaintedContent(container, window, layout)'
        : 'registerPaintedContentFallback(window, layout)',
      fixture.context,
    );
    const paint = fixture.handlers.get('paint');
    expect(paint).toBeFunction();
    if (!paint) throw new Error('Paint listener was not registered');
    await paint({}, {}, fixture.image);
    expect(fixture.counts).toEqual({ allocations: 1, bitmaps: 1, publications: 1 });
  }
});

test('no-paint skips initial images and listener registration', () => {
  const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('  function registerPaints('),
    source.indexOf('  registerPaints(padSize'),
  );
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(block);
  const destructors = [() => {}];
  const refreshers = [() => {}];
  const context = vm.createContext({ noPaint: true, destructors, refreshers });
  vm.runInContext(`${javascript}\nregisterPaints({width:10,height:10});`, context);
  expect(destructors).toEqual([]);
  expect(refreshers).toEqual([]);
});

test('paint cleanup works when invoked as an unbound callback', async () => {
  for (const animation of [true, false]) {
    const fixture = paintFixture(false);
    const result = vm.runInContext(
      animation
        ? 'registerPaintedContent(container, window, layout)'
        : 'registerPaintedContentFallback(window, layout)',
      fixture.context,
    );
    const paint = fixture.handlers.get('paint');
    if (!paint) throw new Error('Paint listener was not registered');
    await paint({}, {}, fixture.image);
    expect(result.buffer).toBeDefined();
    const destroy = result.destroy;
    destroy();
    expect(result.buffer).toBeUndefined();
    expect(fixture.handlers.has('paint')).toBe(false);
    expect(fixture.cleanup.images).toBe(animation ? 0 : 1);
    destroy();
    expect(fixture.cleanup.images).toBe(animation ? 0 : 1);
    await paint({}, {}, fixture.image);
    expect(result.buffer).toBeUndefined();
    expect(fixture.counts).toEqual({ allocations: 1, bitmaps: 1, publications: 1 });
    expect(fixture.cleanup.images).toBe(animation ? 0 : 1);
  }
});

test('replacement painter restores page and review before the next Chromium paint', async () => {
  const fixture = paintFixture(false);
  vm.runInContext('painted = registerPaintedContent(container, window, layout, undefined, undefined, undefined, {window: overlay, layout});', fixture.context);
  await fixture.handlers.get('paint')?.({}, {}, fixture.image);
  fixture.overlayHandlers.get('paint')?.({}, {}, fixture.image);
  const publications = fixture.counts.publications;
  vm.runInContext('layout.deviceLayout.width = 20; replacement = registerPaintedContent(container, window, layout, undefined, undefined, undefined, {window: overlay, layout}); painted.destroy();', fixture.context);
  expect(fixture.counts.publications).toBeGreaterThan(publications);
  expect(fixture.composites.at(-1)).toBe(true);
  // Kitty composition copies pixels; asking for the new width would exceed
  // the retained 10px source frame until Chromium paints at 20px.
  expect(fixture.compositeRects.at(-1)?.width).toBe(10);
  expect(fixture.overlayHandlers.has('paint')).toBe(true);
});

test('old-size toolbar frames are ignored after layout resize', () => {
  const fixture = paintFixture(false);
  vm.runInContext('registerPaintedContent(container, window, layout, undefined, undefined, undefined, {window: overlay, layout}); layout.deviceLayout.width = 20;', fixture.context);
  fixture.overlayHandlers.get('paint')?.({}, {}, fixture.image);
  expect(fixture.counts.publications).toBe(0);
});

test('toolbar repaint composites without waiting for a page paint after resize', () => {
  const fixture = paintFixture(false);
  vm.runInContext(
    'globalThis.result = registerPaintedContent(container, window, layout, undefined, undefined, undefined, {window: overlay, layout});',
    fixture.context,
  );
  fixture.overlayHandlers.get('paint')?.({}, {}, fixture.image);
  expect(fixture.composites).toEqual([false, false, true]);
  expect(fixture.handlers.has('paint')).toBe(true);
});

