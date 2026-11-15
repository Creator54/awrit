import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');

test.each([false, true])('page fallback respects transparent mode (%s)', (transparent) => {
  const block = source.match(/if \(!transparent && !terminalReview\) \{\n\s*\/\/ The native review[\s\S]*?\n {6}\}/)?.[0];
  if (!block) throw new Error('Page background fallback is missing');
  const inserted: unknown[][] = [];
  vm.runInNewContext(block, {
    transparent,
    terminalReview: undefined,
    content: { webContents: { insertCSS: (...args: unknown[]) => inserted.push(args) } },
  });
  expect(inserted).toEqual(transparent ? [] : [['html { background-color: white; }', { cssOrigin: 'user' }]]);
});

test('content preload does not force a dark color scheme on websites', () => {
  const preload = readFileSync(new URL('./content-preload.js', import.meta.url), 'utf8');
  expect(preload).not.toContain('color-scheme: dark !important');
});
