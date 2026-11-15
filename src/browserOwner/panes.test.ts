import { expect, test } from 'bun:test';
import { PaneRegistry } from './panes';

test('first detach preserves owner; last detach enters irreversible draining', () => {
  let shutdowns = 0;
  const panes = new PaneRegistry(() => shutdowns++);
  expect(panes.attach('first')).toBe(true);
  expect(panes.attach('second')).toBe(true);
  panes.detach('first');
  expect(shutdowns).toBe(0);
  expect(panes.attach('third')).toBe(true);
  panes.detach('second');
  panes.detach('third');
  expect(shutdowns).toBe(1);
  expect(panes.attach('late')).toBe(false);
  panes.detach('third');
  expect(shutdowns).toBe(1);
});

test('shutdown rejects future attaches and runs once', () => {
  let shutdowns = 0;
  const panes = new PaneRegistry(() => shutdowns++);
  panes.attach('first');
  panes.shutdown();
  panes.shutdown();
  expect(panes.attach('late')).toBe(false);
  panes.detach('first');
  expect(shutdowns).toBe(1);
});
