import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/Toolbar.tsx', import.meta.url), 'utf8');

test('URL focus is cancelled on close, replacement and toolbar cleanup', () => {
  const start = source.indexOf('  let urlFocusTimer');
  const end = source.indexOf('\n  window.ipc.onPermissionRequest', start);
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
  let toggle!: (visible: boolean) => void;
  let visible = false;
  let permissionPending = false;
  let effect: (() => void) | undefined;
  let cleanup: (() => void) | undefined;
  let focused = 0;
  let next = 0;
  const timers = new Map<number, () => void>();
  new Function('window', 'setOmniboxVisible', 'omniboxVisible', 'setSiteInfoOpen', 'setUrl',
    'lastCommittedUrl', 'setSelectedIndex', 'inputRef', 'setTimeout', 'clearTimeout', 'createEffect', 'onCleanup', 'permissionReq', code)(
    { ipc: { onSetUrlBarVisible: (fn: typeof toggle) => { toggle = fn; } } },
    (value: boolean) => { visible = value; }, () => visible, () => {}, () => {}, () => '', () => {},
    { focus: () => { focused++; }, select() {} },
    (fn: () => void) => { timers.set(++next, fn); return next; },
    (id: number) => { timers.delete(id); },
    (fn: () => void) => { effect = fn; }, (fn: () => void) => { cleanup = fn; }, () => permissionPending,
  );
  const refresh = () => { effect?.(); };
  const flush = () => { const callbacks = [...timers.values()]; timers.clear(); for (const fn of callbacks) fn(); };
  toggle(true); refresh(); toggle(false); refresh(); flush();
  expect(focused).toBe(0);
  toggle(true); refresh(); toggle(true); refresh(); flush();
  expect(focused).toBe(1);
  toggle(true); refresh(); visible = false; refresh(); flush();
  expect(focused).toBe(1); // Direct closure, such as opening Find.
  permissionPending = true;
  toggle(true); refresh(); flush();
  expect(focused).toBe(1);
  permissionPending = false;
  toggle(true); refresh(); cleanup?.(); flush();
  expect(focused).toBe(1);
});
