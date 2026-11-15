import { expect, test } from 'bun:test';
import { selectPane, matchPane } from './target';

const panes = [
  { id: 'one', sourceWindowId: '11', kittyWindowId: '21' },
  { id: 'two', sourceWindowId: '12', kittyWindowId: '22' },
];

test('explicit targeting never broadcasts or falls back to another pane', () => {
  expect(selectPane(panes, { paneId: 'two' })).toBe(panes[1]);
  expect(selectPane(panes, { sourceWindowId: '11' })).toBe(panes[0]);
  expect(selectPane(panes, { kittyWindowId: '22' })).toBe(panes[1]);
  expect(() => selectPane(panes, {})).toThrow('Ambiguous');
  expect(() => selectPane(panes, { paneId: 'absent' })).toThrow('No matching');
  expect(() => selectPane(panes, { paneId: 'one', sourceWindowId: '12' })).toThrow('No matching');
  expect(selectPane([panes[0]], {})).toBe(panes[0]);
});

test('matchPane returns structured no-match on zero matches, while preserving ambiguous error', () => {
  expect(matchPane(panes, { paneId: 'absent' })).toEqual({ ok: false, reason: 'no-match' });
  expect(matchPane(panes, { paneId: 'one' })).toEqual({ ok: true, pane: panes[0] });
  expect(() => matchPane(panes, {})).toThrow('Ambiguous');
});
