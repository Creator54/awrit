import { expect, test } from 'bun:test';
import { verifySourceFeedback } from './sourceFeedback';

const snapshot = { path: '/project/code.ts', sha256: 'a'.repeat(64), text: 'one\ntwo\nthree' };
const source = { kind: 'document' as const, path: snapshot.path, sha256: snapshot.sha256 };
const range = { startLine: 2, endLine: 3, text: 'two\nthree' };
const notes = [{ sourceRange: range }];

test('owner accepts only exact context from the captured source identity', () => {
  expect(() => verifySourceFeedback(notes, source, snapshot)).not.toThrow();
  expect(() => verifySourceFeedback(notes, source, undefined)).toThrow();
  expect(() => verifySourceFeedback(notes, { ...source, path: '/other/code.ts' }, snapshot)).toThrow();
  expect(() => verifySourceFeedback(notes, { ...source, sha256: 'b'.repeat(64) }, snapshot)).toThrow();
  expect(() => verifySourceFeedback([{ sourceRange: { ...range, text: 'forged' } }], source, snapshot)).toThrow();
  expect(() => verifySourceFeedback([{ sourceRange: { startLine: 2, endLine: 4, text: 'two\nthree' } }], source, snapshot)).toThrow();
  expect(() => verifySourceFeedback(notes, { kind: 'web', url: 'https://example.test' }, snapshot)).toThrow();
  expect(() => verifySourceFeedback([{}], undefined, undefined)).not.toThrow();
});
