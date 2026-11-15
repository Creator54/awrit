import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/Toolbar.tsx', import.meta.url), 'utf8');
const start = source.lastIndexOf('  onMount(', source.indexOf("localStorage.getItem('awrit:history')"));
const end = source.indexOf('\n\n  return (', start);
const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));

function load(stored: string | null, unavailable = false) {
  let history: unknown[] = [];
  new Function('onMount', 'localStorage', 'setHistory', code)(
    (fn: () => void) => fn(), { getItem: () => { if (unavailable) throw new Error('Storage unavailable'); return stored; } }, (items: unknown[]) => { history = items; },
  );
  return history;
}

test('invalid stored history does not break toolbar startup or suggestions', () => {
  expect(load(null, true)).toEqual([]);
  for (const stored of [null, '', '{', 'null', '{}', '42', '[null,{},"bad"]']) {
    expect(() => load(stored)).not.toThrow();
    expect(load(stored)).toEqual([]);
  }
});

test('only valid history entries reach suggestions', () => {
  const valid = { title: 'Example', url: 'https://example.com', isSearch: false };
  expect(load(JSON.stringify([valid, { ...valid, title: 3 }, { ...valid, isSearch: 'false' }, null])))
    .toEqual([valid]);
});
