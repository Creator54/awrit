import { afterEach, expect, test } from 'bun:test';
import { noteUserInput, resetUserInput, USER_IDLE_MS, waitForUserIdle } from './userActivity';

afterEach(resetUserInput);

test('proceeds at once when the user has not been active', async () => {
  expect(await waitForUserIdle()).toBe(true);
});

test('waits out a short burst of user input', async () => {
  noteUserInput(Date.now() - USER_IDLE_MS + 100);
  const start = Date.now();
  expect(await waitForUserIdle()).toBe(true);
  expect(Date.now() - start).toBeGreaterThanOrEqual(80);
});

test('gives up while the user keeps typing', async () => {
  noteUserInput(Date.now() + 5_000);
  expect(await waitForUserIdle()).toBe(false);
});

test('tells the caller once that it is waiting for the user', async () => {
  noteUserInput(Date.now() + 5_000);
  let calls = 0;
  await waitForUserIdle(() => calls++);
  expect(calls).toBe(1);
});
