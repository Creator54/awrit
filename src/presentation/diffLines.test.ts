import { expect, test } from 'bun:test';
import { mapDiffLines } from './diffLines';

test('unified hunks map old and new coordinates independently', () => {
  expect(mapDiffLines(['--- a/file', '+++ b/file', '@@ -8,2 +9,2 @@', ' same', '-old', '+new', '\\ No newline at end of file'])).toEqual([
    { kind: 'meta', text: '--- a/file' }, { kind: 'meta', text: '+++ b/file' },
    { kind: 'meta', text: '@@ -8,2 +9,2 @@' },
    { kind: 'context', text: ' same', oldLine: 8, newLine: 9 },
    { kind: 'removed', text: '-old', oldLine: 9 },
    { kind: 'added', text: '+new', newLine: 10 },
    { kind: 'meta', text: '\\ No newline at end of file' },
  ]);
});

test('zero-count hunks and subsequent files do not create false line coordinates', () => {
  const rows = mapDiffLines(['@@ -0,0 +1 @@', '+new', '--- a/next', '+++ b/next', '@@ -5 +0,0 @@', '-old', '+outside']);
  expect(rows[1]).toEqual({ kind: 'added', text: '+new', newLine: 1 });
  expect(rows[3]?.kind).toBe('meta');
  expect(rows[5]).toEqual({ kind: 'removed', text: '-old', oldLine: 5 });
  expect(rows[6]?.kind).toBe('meta');
});
