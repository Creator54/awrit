import { expect, test } from 'bun:test';
import { decodeAttach } from './attach';

const request = {
  type: 'attach',
  version: 1,
  build: 'test-build',
  debugPort: 'disabled',
  url: 'https://example.com',
  settings: {
    overlay: false,
    design: false,
    transparent: false,
    noPaint: false,
    debugPaint: false,
  },
  size: { width: 800, height: 600, cols: 80, rows: 30 },
  features: { keyboard: true, images: true, loadFrame: true, compositeFrame: true },
};

test('attach accepts only validated companion options', () => {
  const companion = { text: 'Hello', layout: 'text-left' as const, columns: { text: 50, media: 50 } };
  expect(decodeAttach({ ...request, companion }, 'test-build').companion).toEqual(companion);
  for (const bad of [{ text: 42 }, { layout: 'other' }, { extra: true }, 'bad']) {
    expect(() => decodeAttach({ ...request, companion: bad }, 'test-build')).toThrow();
  }
});

test('attach accepts only a #rrggbb terminal background', () => {
  expect(decodeAttach({ ...request, terminalBackground: '#1d2021' }, 'test-build').terminalBackground).toBe('#1d2021');
  for (const bad of ['1d2021', '#1D2021', '#fff', 'red', 7]) {
    expect(() => decodeAttach({ ...request, terminalBackground: bad }, 'test-build')).toThrow('Invalid terminal background');
  }
});

test('attach accepts only validated pane-owned Android stream options', () => {
  expect(
    decodeAttach({ ...request, android: { target: 'phone', maxSize: 720 } }, 'test-build').android,
  ).toEqual({ target: 'phone', maxSize: 720 });
  for (const android of [
    { target: 42 },
    { maxSize: -1 },
    { bitrate: 'bad' },
    { forged: true },
    [],
  ]) {
    expect(() => decodeAttach({ ...request, android }, 'test-build')).toThrow();
  }
});

test('attach validates build, fields, dimensions and capabilities before creating a pane', () => {
  expect(decodeAttach(request, 'test-build')).toEqual(request);
  expect(() => decodeAttach(request, 'other-build')).toThrow('Incompatible');
  expect(() => decodeAttach(request, 'test-build', '9222')).toThrow('debugging port');
  expect(() => decodeAttach({ ...request, paneId: 'forged' }, 'test-build')).toThrow();
  expect(() => decodeAttach({ ...request, version: 2 }, 'test-build')).toThrow();
  expect(() =>
    decodeAttach({ ...request, size: { ...request.size, width: 0 } }, 'test-build'),
  ).toThrow();
  expect(() =>
    decodeAttach({ ...request, features: { ...request.features, keyboard: 'true' } }, 'test-build'),
  ).toThrow();
  expect(() => decodeAttach({ ...request, url: 'x'.repeat(32769) }, 'test-build')).toThrow();
});
