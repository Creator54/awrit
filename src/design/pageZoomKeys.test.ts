import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('live page standard zoom shortcuts use existing persistence handler and leave review/unmodified keys alone', () => {
  const source = readFileSync(new URL('../windows.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const onPageZoomKey =');
  const end = source.indexOf('  const startProgress =', start);
  let zoom = 1;
  let prevented = 0;
  const view = { designMode: false };
  const context = vm.createContext({ view,
    contentContents: { isDestroyed: () => false, getZoomFactor: () => zoom, on() {} },
    handlers: { 'toolbar:set-zoom': (_event: unknown, factor: number) => { zoom = factor; } },
    event: { preventDefault: () => { prevented++; } },
    input: { type: 'keyDown', key: '=', control: true, meta: false, alt: false },
  });
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
  vm.runInContext(`${code}; onPageZoomKey(event,input);`, context);
  expect(zoom).toBe(1.1);
  context.input.control = false; context.input.meta = true; context.input.key = '0';
  vm.runInContext('onPageZoomKey(event,input)', context); expect(zoom).toBe(1);
  context.input.meta = false; context.input.key = '-';
  vm.runInContext('onPageZoomKey(event,input)', context); expect(prevented).toBe(2);
  context.input.control = true; view.designMode = true;
  vm.runInContext('onPageZoomKey(event,input)', context); expect(prevented).toBe(2);
});

test('onPageZoomKey decreases on Ctrl -, increases on Meta +, and ignores keyUp, alt, and unrelated ctrl keys', () => {
  const source = readFileSync(new URL('../windows.ts', import.meta.url), 'utf8');
  const start = source.indexOf('  const onPageZoomKey =');
  const end = source.indexOf('  const startProgress =', start);
  let zoom = 1;
  let prevented = 0;
  const view = { designMode: false };
  const context = vm.createContext({
    view,
    contentContents: { isDestroyed: () => false, getZoomFactor: () => zoom, on() {} },
    handlers: { 'toolbar:set-zoom': (_event: unknown, factor: number) => { zoom = factor; } },
    event: { preventDefault: () => { prevented++; } },
    input: { type: 'keyDown', key: '-', control: true, meta: false, alt: false },
  });
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
  vm.runInContext(`${code}; onPageZoomKey(event,input);`, context);

  // Ctrl '-' decreases zoom
  expect(zoom).toBeCloseTo(0.9, 5);
  expect(prevented).toBe(1);

  // Meta '+' increases zoom
  context.input = { type: 'keyDown', key: '+', control: false, meta: true, alt: false };
  vm.runInContext('onPageZoomKey(event,input);', context);
  expect(zoom).toBeCloseTo(1.0, 5);
  expect(prevented).toBe(2);

  // keyUp ignored
  context.input = { type: 'keyUp', key: '=', control: true, meta: false, alt: false };
  vm.runInContext('onPageZoomKey(event,input);', context);
  expect(zoom).toBeCloseTo(1.0, 5);
  expect(prevented).toBe(2);

  // Alt-modified ignored
  context.input = { type: 'keyDown', key: '=', control: true, meta: false, alt: true };
  vm.runInContext('onPageZoomKey(event,input);', context);
  expect(zoom).toBeCloseTo(1.0, 5);
  expect(prevented).toBe(2);

  // Unrelated ctrl key ignored
  context.input = { type: 'keyDown', key: 'x', control: true, meta: false, alt: false };
  vm.runInContext('onPageZoomKey(event,input);', context);
  expect(zoom).toBeCloseTo(1.0, 5);
  expect(prevented).toBe(2);
});

