import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/Toolbar.tsx', import.meta.url), 'utf8');
const start = source.indexOf('  const persistHistory =');
const end = source.indexOf('\n  const getSuggestions', start);
const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));

test('unavailable history storage does not interrupt history actions', () => {
  let history: Array<{ title: string; url: string; isSearch: boolean }> = [];
  let writes = 0;
  let available = false;
  const saved: Array<[string, string]> = [];
  const { addToHistory, removeFromHistory } = new Function('setHistory', 'localStorage', 'console',
    `${code}; return { addToHistory, removeFromHistory };`)(
    (update: (previous: typeof history) => typeof history) => { history = update(history); },
    { setItem: (key: string, value: string) => {
      writes++;
      if (!available) throw new Error('Quota exceeded');
      saved.push([key, value]);
    } },
    { warn() {} },
  );
  expect(() => addToHistory('Example', 'https://example.com', false)).not.toThrow();
  expect(history).toEqual([{ title: 'Example', url: 'https://example.com', isSearch: false }]);
  expect(() => removeFromHistory('https://example.com')).not.toThrow();
  expect(history).toEqual([]);
  expect(writes).toBe(2);
  available = true;
  addToHistory('Example', 'https://example.com', false);
  expect(saved).toEqual([['awrit:history', JSON.stringify(history)]]);
});
