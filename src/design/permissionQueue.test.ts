import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

test('a new permission prompt answers the one it replaces', () => {
  const source = readFileSync(new URL('../session.ts', import.meta.url), 'utf8');
  const answer = source.indexOf('earlier.callback(false)');
  const register = source.indexOf('pendingPermissions.set(id, { callback: finish');
  expect(answer).toBeGreaterThan(0);
  expect(answer).toBeLessThan(register);
});
