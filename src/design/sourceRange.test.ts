import { expect, test } from 'bun:test';
import { sourceRangeContext } from './sourceRange';

test('source range normalizes reverse selection and preserves exact snapshot lines', () => {
  expect(sourceRangeContext('one\r\ntwo\r\nthree', 3, 2)).toEqual({ startLine: 2, endLine: 3, text: 'two\nthree' });
  expect(() => sourceRangeContext('one', 0, 1)).toThrow();
  expect(() => sourceRangeContext('one', 1, 2)).toThrow();
  expect(() => sourceRangeContext('one', 1.5, 1)).toThrow();
  expect(() => sourceRangeContext(Array(102).fill('x').join('\n'), 1, 102)).toThrow();
  expect(() => sourceRangeContext('x'.repeat(8193), 1, 1)).toThrow();
});
