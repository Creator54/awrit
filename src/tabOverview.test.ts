import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
const start = source.indexOf("    'toolbar:select-tab':");
const end = source.indexOf("    'toolbar:toggle-find':", start);
const javascript = new Bun.Transpiler({ loader: 'ts' }).transformSync(
  `globalThis.handlers = ({${source.slice(start, end)}})`,
);

function selection(visible: boolean, index: unknown) {
  const calls: string[] = [];
  const view = {
    omniboxVisible: visible,
    terminal: {
      actions: {
        list: () => [{ current: true }, { current: false }],
        select: (n: number) => calls.push(`select:${n}`),
      },
    },
    toggleOmnibox: () => calls.push('close'),
  };
  const handlers = vm.runInNewContext(javascript, { view });
  handlers['toolbar:select-tab']({}, index);
  return calls;
}

test('switching pages through another shortcut dismisses the old omnibox', () => {
  const owner = readFileSync(new URL('./browserOwner/paneSession.ts', import.meta.url), 'utf8');
  const begin = owner.indexOf('  const showPage =');
  const end = owner.indexOf('  terminal.actions =', begin);
  const calls: string[] = [];
  const old = { omniboxVisible: true, toggleOmnibox: () => calls.push('close') };
  const next = { relayout: () => calls.push('layout') };
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(
    `${owner.slice(begin, end)} showPage(next);`,
  );
  vm.runInNewContext(code, { view: old, next, agentPanes: new Map(), connectionId: 'test' });
  expect(calls).toEqual(['close', 'layout']);
});

test('tab selection closes the omnibox before switching pages', () => {
  expect(selection(true, 1)).toEqual(['close', 'select:1']);
});

test('stale or invalid tab selections cannot switch pages', () => {
  expect(selection(false, 0)).toEqual([]);
  for (const index of [-1, 2, 0.5, NaN, '1', null]) {
    expect(selection(true, index)).toEqual([]);
  }
});
