import { expect, test } from 'bun:test';
import { childExitCode } from './exitCode';

test('launcher passes through the Electron exit code', () => {
  expect(childExitCode(0, null)).toBe(0);
  expect(childExitCode(3, null)).toBe(3);
  expect(childExitCode(null, 'SIGSEGV')).toBe(1);
  expect(childExitCode(null, null)).toBe(0);
});
test('numeric signal codes also map to 1', () => expect(childExitCode(null, 11)).toBe(1));
