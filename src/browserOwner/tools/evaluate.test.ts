import { expect, test } from 'bun:test';
import { MAX_EXPRESSION_CHARS, evaluateInPage } from './evaluate';
import { MAX_TEXT_CHARS } from './text';

const page = (result: unknown) => ({ executeJavaScript: async () => result }) as never;

test('evaluate returns the serialized value', async () => {
  expect(await evaluateInPage(page({ count: 3 }), 'document.querySelectorAll("li").length')).toEqual({
    result: '{"count":3}',
  });
  expect(await evaluateInPage(page('hello'), 'location.href')).toEqual({ result: '"hello"' });
});

test('evaluate reports a thrown page error instead of failing the call', async () => {
  const wc = {
    executeJavaScript: async () => {
      throw new Error('ReferenceError: nope is not defined');
    },
  } as never;
  expect(await evaluateInPage(wc, 'nope()')).toEqual({
    error: 'ReferenceError: nope is not defined',
  });
});

test('evaluate clips a large result to the output limit', async () => {
  const outcome = await evaluateInPage(page('x'.repeat(MAX_TEXT_CHARS + 100)), 'document.body.innerText');
  expect(outcome.result?.length).toBe(MAX_TEXT_CHARS + 1);
  expect(outcome.result?.endsWith('…')).toBe(true);
});

test('evaluate bounds and rejects an unusable expression', async () => {
  expect(await evaluateInPage(page(1), '')).toMatchObject({ error: 'expression must be a non-empty string' });
  expect(await evaluateInPage(page(1), 42)).toMatchObject({ error: 'expression must be a non-empty string' });
  expect(await evaluateInPage(page(1), 'x'.repeat(MAX_EXPRESSION_CHARS + 1))).toMatchObject({
    error: `expression must be ${MAX_EXPRESSION_CHARS} characters or fewer`,
  });
});

test('evaluate handles values JSON cannot serialize', async () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  expect(await evaluateInPage(page(undefined), 'void 0')).toEqual({ result: 'undefined' });
  expect((await evaluateInPage(page(circular), 'window')).result).toBeDefined();
});
