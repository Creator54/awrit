import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/Toolbar.tsx', import.meta.url), 'utf8');

test('Find arrow buttons cancel typing searches before navigating', () => {
  for (const forward of [false, true]) {
    const title = source.indexOf(`title="${forward ? 'Next (Enter)' : 'Previous (Shift+Enter)'}"`);
    const start = source.lastIndexOf('onClick={', title);
    const end = source.indexOf('\n', start);
    const expression = source.slice(start + 'onClick={'.length, end).trim().slice(0, -1);
    const calls: unknown[] = [];
    let query = 'query';
    const bindingStart = source.indexOf('  const navigateFind =');
    const bindingEnd = source.indexOf('\n  const handleFindKeyDown', bindingStart);
    const helper = bindingStart < 0 ? '' : new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(bindingStart, bindingEnd));
    const click = new Function('window', 'findText', 'debouncedFindInPage', 'performSearch',
      `${helper}; return (${expression});`)(
      { ipc: { findInPage: (...args: unknown[]) => calls.push(args) } }, () => query,
      { cancel: () => calls.push('cancel') }, (...args: unknown[]) => calls.push(args),
    );
    click();
    expect(calls).toEqual(['cancel', ['query', { findNext: true, forward }]]);
    calls.length = 0;
    query = '';
    click();
    expect(calls).toEqual(['cancel']);
  }
});
