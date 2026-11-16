import { expect, test } from 'bun:test';
import { groupShortcuts, shortcutKeyText } from './shortcutReference';

test('merges equivalent actions, keeps aliases searchable and primary first', () => {
  const rows = groupShortcuts([
    { action: 'newWindow', keys: ['<C-t>', '<A-t>'], primaryKey: '<A-t>' },
    { action: 'newTab', keys: ['<A-a>t'] },
    { action: 'refresh', keys: ['r'] },
    { action: 'refreshPage', keys: ['<C-r>'] },
  ]);
  expect(rows.find((g) => g.name === 'Tabs')?.items).toEqual([
    { action: 'New tab', keys: ['Alt+T', 'Ctrl+T', 'Alt+A t'] },
  ]);
  expect(
    groupShortcuts(
      [{ action: 'newWindow', keys: ['<A-t>', '<C-t>'], primaryKey: '<A-t>' }],
      'ctrl+t',
    )[0].items[0].keys,
  ).toEqual(['Ctrl+T']);
  expect(rows.find((g) => g.name === 'Navigation')?.items).toHaveLength(1);
  expect(groupShortcuts([{ action: 'zoomIn', keys: ['<A-=>'] }], 'tabs')).toEqual([]);
});

test('uppercase keys show held Shift, sequences remain sequential', () => {
  expect(shortcutKeyText('H')).toBe('Shift+H');
  expect(shortcutKeyText('gg')).toBe('g g');
});

test('design feedback is listed under Page', () => {
  expect(groupShortcuts([{ action: 'toggleDesignMode', keys: ['<A-d>'] }])[0].name).toBe('Page');
});

test('collapses complete tab ranges, never advertises absent numbers', () => {
  const tabs = Array.from({ length: 9 }, (_, i) => ({
    action: `Go to tab ${i + 1}`,
    keys: [`<A-${i + 1}>`],
  }));
  expect(groupShortcuts(tabs)[0].items).toEqual([{ action: 'Go to tab', keys: ['Alt+1–9'] }]);
  expect(groupShortcuts(tabs.slice(0, 2))[0].items[0].keys).toEqual(['Alt+1', 'Alt+2']);
  const superTabs = tabs.map((tab, i) => ({
    ...tab,
    keys: [`<M-${i + 1}>`, ...tab.keys],
    primaryKey: `<M-${i + 1}>`,
  }));
  expect(groupShortcuts(superTabs)[0].items[0].keys).toEqual(['Super/Cmd+1–9', 'Alt+1–9']);
});

test('formats modifiers and preserves named/configured actions', () => {
  expect(shortcutKeyText('<M-S-Tab>')).toBe('Super/Cmd+Shift+Tab');
  expect(shortcutKeyText('<C-minus>')).toBe('Ctrl+−');
  expect(groupShortcuts([{ action: 'My custom action', keys: ['<F8>'] }])[0]).toEqual({
    name: 'Advanced',
    items: [{ action: 'My custom action', keys: ['F8'] }],
  });
  expect(groupShortcuts([{ action: 'copy', keys: ['<C-c>'] }], 'editing')).toHaveLength(1);
});
