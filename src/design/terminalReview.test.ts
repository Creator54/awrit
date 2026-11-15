import { expect, test } from 'bun:test';
import { terminalReviewTarget, parseTerminalReviewTarget } from './terminalReview';

test('terminal review target preserves exact source and capture path', () => {
  const target = terminalReviewTarget('42', '/tmp/review space/capture.png');
  expect(parseTerminalReviewTarget(target)).toEqual({ windowId: '42', imagePath: '/tmp/review space/capture.png' });
  expect(parseTerminalReviewTarget('https://example.com')).toBeUndefined();
});

test('rejects malformed or ambiguous terminal targets', () => {
  for (const target of ['awrit://terminal-review/0?image=/tmp/a', 'awrit://terminal-review/12?image=relative', 'awrit://terminal-review/12?image=/tmp/a&image=/tmp/b']) {
    expect(() => parseTerminalReviewTarget(target)).toThrow();
  }
});
