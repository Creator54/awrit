import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/Toolbar.tsx', import.meta.url), 'utf8');

function handler(name: string, end: string, bindings: Record<string, unknown>) {
  const start = source.indexOf(`const ${name} =`);
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, source.indexOf(end, start)));
  return new Function(...Object.keys(bindings), `${code}; return ${name};`)(...Object.values(bindings));
}

test('IME candidate keys do not navigate Find or dismiss toolbar popups', () => {
  const calls: string[] = [];
  const find = handler('handleFindKeyDown', '\n  const getUrlOrSearch', {
    navigateFind: () => calls.push('cancel', 'search'),
    window: { ipc: { toggleFind: () => calls.push('close') } },
  });
  const global = handler('handleGlobalKeyDown', '\n    window.addEventListener', {
    permissionReq: () => null, keyHelp: () => ({ visible: false }), findVisible: () => true,
    window: { ipc: { toggleFind: () => calls.push('close') } },
  });
  const url = handler('handleKeyDown', '\n  createEffect', {
    getSuggestions: () => { calls.push('suggestions'); return []; }, selectedIndex: () => -1, url: () => '',
    historyOpen: () => false, siteInfoOpen: () => false, window: { ipc: { toggleUrlBar() {} } },
  });
  for (const flags of [{ isComposing: true }, { keyCode: 229 }]) {
    for (const key of ['Enter', 'Escape']) {
      const event = { key, ...flags, preventDefault() {}, stopPropagation() {} };
      find(event); global(event); url(event);
    }
  }
  expect(calls).toEqual([]);
  find({ key: 'Enter', stopPropagation() {} });
  expect(calls).toEqual(['cancel', 'search']);
  global({ key: 'Escape', preventDefault() {}, stopPropagation() {} });
  expect(calls).toEqual(['cancel', 'search', 'close']);
});


test('Escape in the permission prompt does not reach the underlying toolbar', () => {
  const start = source.indexOf('onKeyDown={(e) => {', source.indexOf('class="permission-palette"'));
  const end = source.indexOf('\n              }}', start);
  const calls: string[] = [];
  const expression = source.slice(start, end + '\n              }'.length).replace('onKeyDown={', '');
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(`const onKeyDown = ${expression};`);
  const onKeyDown = new Function('window', 'req', 'setPermissionReq', `${code}; return onKeyDown;`)(
    { ipc: { resolvePermission: () => calls.push('deny') } },
    () => ({ id: 1, url: 'https://example.test', permission: 'geolocation' }),
    () => calls.push('dismiss'),
  );
  onKeyDown({ key: 'Escape', preventDefault() {}, stopPropagation: () => calls.push('stop') });
  expect(calls).toEqual(['stop', 'deny', 'dismiss']);
});

test('hiding Find cancels a queued search and hidden callbacks cannot search', () => {
  let visible = true;
  let callback!: (text: string) => void;
  let cancelled = 0;
  let cleanup!: () => void;
  const searches: string[] = [];
  const debounced = handler('debouncedFindInPage', '\n  const handleFindInput', {
    debounce: (_delay: number, fn: (text: string) => void) => {
      callback = fn;
      return { cancel: () => { cancelled++; } };
    },
    onCleanup: (fn: () => void) => { cleanup = fn; }, findVisible: () => visible, performSearch: (text: string) => searches.push(text),
  });
  let toggle!: (value: boolean) => void;
  const start = source.indexOf('  window.ipc.onToggleFind(');
  const end = source.indexOf('\n\n  window.ipc.onFindResult', start);
  new Function('window', 'findVisible', 'setFindVisible', 'setActiveMatch', 'setTotalMatches',
    'debouncedFindInPage', 'findFocusTimer', source.slice(start, end).replace('(visible?: boolean)', '(visible)'))(
    { ipc: { onToggleFind: (fn: typeof toggle) => { toggle = fn; } } },
    () => visible, (value: boolean) => { visible = value; }, () => {}, () => {}, debounced,
  );
  callback('visible');
  expect(searches).toEqual(['visible']);
  toggle(false);
  expect(cancelled).toBe(1);
  callback('stale');
  expect(searches).toEqual(['visible']);
  cleanup();
  expect(cancelled).toBe(2);
});
