import { expect, test } from 'bun:test';
import { canReuseViewer, validateLiveCapture } from './sessionOwnership';

test('viewer reuse refuses different and missing owners', () => {
  expect(canReuseViewer({ currentOwner: '12', requesterOwner: '13' }).ok).toBe(false);
  expect(canReuseViewer({ currentOwner: '12' }).ok).toBe(false);
  expect(canReuseViewer({ currentOwner: '12', requesterOwner: '12' }).ok).toBe(true);
  expect(canReuseViewer({ currentOwner: '12', requesterOwner: '12', designMode: true }).ok).toBe(false);
});

test('live capture requires matching owner and exact normalized URL', () => {
  const params = { currentOwner: '12', requesterOwner: '12', currentUrl: 'https://example.com/', requestedTarget: 'https://example.com' };
  expect(validateLiveCapture(params).ok).toBe(true);
  expect(validateLiveCapture({ ...params, requesterOwner: '13' }).ok).toBe(false);
  expect(validateLiveCapture({ ...params, requestedTarget: 'https://other.example/' }).ok).toBe(false);
  expect(validateLiveCapture({ ...params, requestedTarget: undefined }).ok).toBe(false);
});
