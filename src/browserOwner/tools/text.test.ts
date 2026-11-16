import { expect, test } from 'bun:test';
import { encodeToolResult } from './encode';
import { MAX_FIELD_CHARS, MAX_TEXT_CHARS, clipField, readPageText } from './text';

const wc = (text: unknown) => ({ executeJavaScript: async () => text });

test('text returns the readable page text', async () => {
  expect(await readPageText(wc('Pricing\n$0.99 / month'))).toEqual({
    text: 'Pricing\n$0.99 / month',
  });
});

test('text is cut to a bounded size and says so', async () => {
  const result = await readPageText(wc('a'.repeat(MAX_TEXT_CHARS + 10)));
  expect(result.text).toHaveLength(MAX_TEXT_CHARS);
  expect(result.truncated).toBe(true);
});

test('text treats a non-string page result as empty', async () => {
  expect(await readPageText(wc(null))).toEqual({ text: '' });
});

test('worst-case multibyte text with oversized url and title still encodes', async () => {
  const page = await readPageText(wc('漢'.repeat(MAX_TEXT_CHARS * 2)));
  const long = clipField('漢'.repeat(MAX_FIELD_CHARS * 5));
  expect(long).toHaveLength(MAX_FIELD_CHARS);
  expect(() => encodeToolResult({ ok: true, url: long, title: long, ...page })).not.toThrow();
});
