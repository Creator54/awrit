import { expect, test } from 'bun:test';
import { performWait } from './wait';

const createMockWebContents = (result: unknown) => ({
  executeJavaScript: async () => result,
});

test('wait for element to appear', async () => {
  const mockResult = { ok: true };
  const wc = createMockWebContents(mockResult) as any;

  const result = await performWait(wc, { selector: '.modal', visible: true });
  expect(result.ok).toBe(true);
  expect(result.ok).toBe(true);
});

test('wait for element to disappear', async () => {
  const mockResult = { ok: true };
  const wc = createMockWebContents(mockResult) as any;

  const result = await performWait(wc, { selector: '.loading', visible: false });
  expect(result.ok).toBe(true);
});

test('wait by timeout only', async () => {
  const result = await performWait({} as any, { ms: 100 });
  expect(result.ok).toBe(true);
  expect(result.ok).toBe(true);
});

test('wait rejects missing selector and ms', async () => {
  const wc = createMockWebContents({}) as any;

  const result = await performWait(wc, {});
  expect(result.ok).toBe(false);
  expect(result.error).toContain('Must provide');
});

test('wait rejects invalid timeout', async () => {
  const wc = createMockWebContents({}) as any;

  const result = await performWait(wc, { ms: 9000 });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('between 0 and 8000');
});

test('wait timeout expires', async () => {
  const mockResult = { ok: false, error: 'Wait timeout' };
  const wc = createMockWebContents(mockResult) as any;

  const result = await performWait(wc, { selector: '.never-appears', ms: 1000 });
  expect(result.ok).toBe(false);
  expect(result.ok).toBe(false);
});
