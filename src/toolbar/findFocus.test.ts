import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/Toolbar.tsx', import.meta.url), 'utf8');

test('Find focus timers belong only to the current visible toolbar', () => {
  const start = source.indexOf('  window.ipc.onToggleFind(');
  const end = source.indexOf('\n\n  window.ipc.onFindResult', start);
  // Include the focus timer's declaration and cleanup when present.
  const timerStart = source.lastIndexOf('  let findFocusTimer', start);
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(timerStart < 0 ? start : timerStart, end));
  let toggle!: (visible: boolean) => void;
  let visible = false;
  const timers = new Map<number, () => void>();
  let next = 0;
  let focused = 0;
  const cleanups: Array<() => void> = [];
  new Function('window', 'findVisible', 'setFindVisible', 'setActiveMatch', 'setTotalMatches',
    'setOmniboxVisible', 'debouncedFindInPage', 'findInputRef', 'setTimeout', 'clearTimeout', 'onCleanup', code)(
    { ipc: { onToggleFind: (fn: typeof toggle) => { toggle = fn; } } },
    () => visible, (value: boolean) => { visible = value; }, () => {}, () => {}, () => {}, { cancel() {} },
    { focus: () => { focused++; }, select() {} },
    (fn: () => void) => { timers.set(++next, fn); return next; },
    (id: number) => { timers.delete(id); }, (fn: () => void) => { cleanups.push(fn); },
  );
  const flush = () => { const callbacks = [...timers.values()]; timers.clear(); for (const fn of callbacks) fn(); };
  toggle(true); toggle(false); flush();
  expect(focused).toBe(0);
  toggle(true); toggle(true); flush();
  expect(focused).toBe(1);
  toggle(true); for (const cleanup of cleanups) cleanup(); flush();
  expect(focused).toBe(1);
});
