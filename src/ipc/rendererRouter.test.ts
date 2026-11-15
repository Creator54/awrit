import { expect, test } from 'bun:test';
import { RendererRouter } from './rendererRouter';

test('closing one renderer preserves sibling handlers', () => {
  const router = new RendererRouter<(value: string) => string>();
  router.add(1, (value) => `first:${value}`);
  router.add(2, (value) => `second:${value}`);
  expect(router.get(1)('hello')).toBe('first:hello');
  expect(router.get(2)('hello')).toBe('second:hello');
  router.remove(1);
  expect(() => router.get(1)).toThrow('Unknown renderer');
  expect(router.get(2)('still here')).toBe('second:still here');
});
