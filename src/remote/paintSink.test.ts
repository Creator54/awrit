import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import type { Surface } from './protocol';

interface Submit {
  surface: Surface;
  bitmap: Uint8Array;
  width: number;
  height: number;
  x: number;
  y: number;
  z: number;
}

function paintFixture() {
  const source = readFileSync(new URL('../paint.ts', import.meta.url), 'utf8');
  // Run the real registration functions without starting Electron or a terminal.
  const functions = source.slice(source.indexOf('const weakPaintedContents_'));
  const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    functions.replaceAll('export function', 'function'),
  );
  const counts = { allocations: 0, bitmaps: 0, publications: 0 };
  const cleanup = { listeners: 0 };
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const context = vm.createContext({
    Buffer,
    Uint8Array,
    options: {},
    rememberTabThumbnail() {},
    features: { current: {} },
    ShmGraphicBuffer: class {
      nameBase64: string;
      constructor() {
        counts.allocations++;
        this.nameBase64 = `buffer-${counts.allocations}`;
      }
      write() {}
    },
    getWindowSize: () => ({ cols: 10, rows: 10, width: 10, height: 10 }),
    defaultOutput: { setModes() {}, startBatch() {}, endBatch() {} },
    defaultGraphics: { paintImage: () => ({ free() {} }) },
    setModes() {},
    startBatch() {},
    endBatch() {},
    Mode: { pendingUpdate: 2026 },
    frameTrace: { now: () => 0, record() {}, skip() {} },
    paintImage: () => ({ free() {} }),
    window: {
      webContents: {
        on(event: string, handler: (...args: unknown[]) => void) {
          handlers.set(event, handler);
        },
        off(event: string) {
          handlers.delete(event);
          cleanup.listeners++;
        },
      },
    },
    container: {
      paintedContent: 0,
      loadFrame() {
        counts.publications++;
        return { composite() {}, delete() {} };
      },
    },
    layout: { deviceLayout: { x: 12, y: 34, width: 10, height: 10 } },
  });
  vm.runInContext(`'use strict';\n${javascript}`, context);
  const image = {
    getSize: () => ({ width: 10, height: 10 }),
    toBitmap() {
      counts.bitmaps++;
      return Buffer.alloc(400).fill(7);
    },
  };
  const submit: Submit[] = [];
  let disposes = 0;
  const sink = {
    submit(value: Submit) {
      submit.push(value);
    },
    grant() {},
    setEpoch() {},
    dispose() {
      disposes++;
    },
  };
  const result = vm.runInContext(
    'registerPaintedContent(container, window, layout, undefined, undefined, sink)',
    Object.assign(context, { sink }),
  ) as { refresh: () => void; destroy: () => void };
  const paint = handlers.get('paint');
  if (!paint) throw new Error('Paint listener was not registered');
  return { context, counts, cleanup, handlers, image, paint, result, sink, submit, disposes: () => disposes };
}

test('without a sink the paint path still uses shared memory and the terminal', async () => {
  const fixture = paintFixture();
  // No sink: register again without the sixth argument.
  fixture.handlers.clear();
  fixture.result = vm.runInContext(
    'registerPaintedContent(container, window, layout)',
    fixture.context,
  ) as typeof fixture.result;
  const paint = fixture.handlers.get('paint');
  if (!paint) throw new Error('Paint listener was not registered');
  await paint({}, {}, fixture.image);
  // The second registration also redraws the retained frame, so counts are lower bounds.
  expect(fixture.counts.bitmaps).toBe(1);
  expect(fixture.counts.allocations).toBeGreaterThanOrEqual(1);
  expect(fixture.counts.publications).toBeGreaterThanOrEqual(1);
  expect(fixture.submit).toEqual([]);
});

test('with a sink the bitmap and geometry replace shared memory and terminal writes', async () => {
  const fixture = paintFixture();
  await fixture.paint({}, {}, fixture.image);
  expect(fixture.counts).toEqual({ allocations: 0, bitmaps: 1, publications: 0 });
  expect(fixture.submit).toEqual([
    {
      surface: 'content',
      bitmap: Buffer.alloc(400).fill(7),
      width: 10,
      height: 10,
      x: 12,
      y: 34,
      z: 0,
    },
  ]);
});

test('refresh resubmits the last bitmap with fresh geometry', async () => {
  const fixture = paintFixture();
  await fixture.paint({}, {}, fixture.image);
  fixture.context.layout.deviceLayout.x = 99;
  fixture.result.refresh();
  expect(fixture.submit.map((value) => [value.x, value.y])).toEqual([
    [12, 34],
    [99, 34],
  ]);
  expect(fixture.submit[1].bitmap).toEqual(fixture.submit[0].bitmap);
});

test('destroy stops painting but leaves the shared sink alive', async () => {
  const fixture = paintFixture();
  await fixture.paint({}, {}, fixture.image);
  fixture.result.destroy();
  expect(fixture.handlers.has('paint')).toBe(false);
  expect(fixture.disposes()).toBe(0);
  await fixture.paint({}, {}, fixture.image);
  expect(fixture.submit.length).toBe(1);
});
