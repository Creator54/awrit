import { expect, test } from 'bun:test';
import { withConstructionCleanup } from './lifecycle';

test('construction failure releases acquired resources in reverse order', async () => {
  const released: string[] = [];
  const error = new Error('setup failed');
  await expect(
    withConstructionCleanup(async (onFailure) => {
      onFailure(() => {
        released.push('window');
      });
      await Promise.resolve();
      onFailure(() => {
        released.push('handlers');
      });
      throw error;
    }),
  ).rejects.toBe(error);
  expect(released).toEqual(['handlers', 'window']);
});

test('successful construction transfers ownership to the caller', async () => {
  let released = false;
  expect(
    await withConstructionCleanup(async (onFailure) => {
      onFailure(() => {
        released = true;
      });
      return 'ready';
    }),
  ).toBe('ready');
  expect(released).toBe(false);
});
