import { expect, test } from 'bun:test';
import { createSyntheticInputGuard } from './syntheticInput';

test('synthetic input is scoped to the target and unwinds after errors', () => {
  const guard = createSyntheticInputGuard();
  const page = {};
  const other = {};
  expect(guard.active(page)).toBe(false);
  expect(() => guard.run(page, () => {
    expect(guard.active(page)).toBe(true);
    expect(guard.active(other)).toBe(false);
    guard.run(page, () => expect(guard.active(page)).toBe(true));
    expect(guard.active(page)).toBe(true);
    throw new Error('send failed');
  })).toThrow('send failed');
  expect(guard.active(page)).toBe(false);
});
