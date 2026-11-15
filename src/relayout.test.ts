import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

function fixture(fail = false) {
  const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
  const start = source.indexOf('      relayout(force = false) {');
  const end = source.indexOf('      toggleOmnibox()', start);
  const queued: (() => void)[] = [];
  let timer: (() => void) | undefined;
  const calls = { registered: 0, oldFreed: 0, partialFreed: 0, ended: 0 };
  const context = vm.createContext({
    relayoutScheduled: false, relayoutForced: false, destroyed: false, terminalReview: undefined,
    designResizeTimer: undefined, designResizePending: false,
    pendingResizeWidth: -1, pendingResizeHeight: -1,
    setTimeout: (fn: () => void) => { timer = fn; return 1; },
    clearTimeout: () => { timer = undefined; },
    lastWidth: 100, lastHeight: 100,
    terminal: { size: { width: 100, height: 100 } },
    setImmediate: (fn: () => void) => queued.push(fn),
    destructors: [() => calls.oldFreed++], refreshers: [],
    updateViewSizes: () => {}, windowOptions: {}, padSize: (size: unknown) => size,
    defaultOutput: { Mode: { pendingUpdate: 2026 } },
    out: { startBatch() {}, setModes() {}, endBatch: () => calls.ended++ },
    registerPaints: () => {
      calls.registered++;
      vm.runInContext('destructors.push(partialCleanup)', context);
      if (fail) throw new Error('allocation failed');
    },
    partialCleanup: () => calls.partialFreed++,
    console_: { error() {} },
    toolbar: { webContents: { invalidate() {} } }, content: { webContents: { invalidate() {} } },
    view: { content: { focusOnWebView() {} }, toolbar: { focusOnWebView() {} } },
  });
  vm.runInContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(`globalThis.subject = {${source.slice(start, end)}}`), context);
  return { context, queued, calls, run: (force = false) => vm.runInContext(`subject.relayout(${force})`, context), settle: () => timer?.(), recover: () => { fail = false; } };
}

test('a queued relayout retains a later forced request at the same size', () => {
  const f = fixture();
  f.run();
  f.run(true);
  expect(f.queued).toHaveLength(1);
  f.queued.shift()?.();
  expect(f.calls.registered).toBe(1);
  expect(f.calls.oldFreed).toBe(1);
});

test('native Design resizes immediately and only recaptures after quiet interval', () => {
  const f = fixture();
  vm.runInContext('subject.designMode = true; terminalReview = {}; refreshes = 0; requestTerminalRefresh = () => refreshes++', f.context);
  f.run();
  expect(vm.runInContext('designResizePending', f.context)).toBe(false);
  vm.runInContext('terminal.size = {width: 140, height: 70}', f.context);
  f.run();
  expect(f.queued).toHaveLength(1);
  expect(vm.runInContext('designResizePending', f.context)).toBe(true);
  f.queued.shift()?.();
  expect(f.calls.registered).toBe(1);
  expect(vm.runInContext('refreshes', f.context)).toBe(0);
  f.run(); // Same-size events must not restart or cancel recapture.
  f.settle();
  expect(vm.runInContext('refreshes', f.context)).toBe(1);
  expect(f.queued).toHaveLength(0);
  expect(vm.runInContext('[lastWidth, lastHeight, designResizePending]', f.context)).toEqual([140, 70, false]);
});

test('web Design resize is immediate rather than waiting for native recapture', () => {
  const f = fixture();
  vm.runInContext('subject.designMode = true; terminal.size = {width: 140, height: 70}', f.context);
  f.run();
  expect(f.queued).toHaveLength(1);
  expect(vm.runInContext('designResizePending', f.context)).toBe(false);
  f.queued.shift()?.();
  expect(f.calls.registered).toBe(1);
});

test('failed replacement cleans up both generations and permits same-size retry', () => {
  const f = fixture(true);
  f.run(true);
  f.queued.shift()?.();
  expect(f.calls).toEqual({ registered: 1, oldFreed: 1, partialFreed: 1, ended: 1 });
  f.recover();
  f.run();
  f.queued.shift()?.();
  expect(f.calls.registered).toBe(2);
});
