import { expect, test } from 'bun:test';
import { normalizePaneLaunch } from './options';

test('companion option parsing parses layout, columns and text into launch options', () => {
  const companion = JSON.stringify({ text: 'Hello', layout: 'text-left', columns: { text: 50, media: 50 } });
  const launch = normalizePaneLaunch([`--presentation-json=${companion}`, 'https://example.com'], '/tmp');
  expect(launch.companion).toEqual({ text: 'Hello', layout: 'text-left', columns: { text: 50, media: 50 } });
  expect(normalizePaneLaunch(['https://example.com'], '/tmp').companion).toBeUndefined();
  expect(() => normalizePaneLaunch(['--presentation-json=invalid-json'], '/tmp')).toThrow();
});

test('Android launch preserves device selection and bounded stream options', () => {
  expect(
    normalizePaneLaunch(['device', 'view', 'phone', '--max-size=720', '--bitrate=2M'], '/tmp')
      .android,
  ).toEqual({ target: 'phone', maxSize: 720, bitrate: '2M' });
  expect(normalizePaneLaunch(['awrit://adb/phone'], '/tmp').android).toEqual({ target: 'phone' });
  expect(normalizePaneLaunch(['device', 'list'], '/tmp').android).toBeUndefined();
  expect(normalizePaneLaunch(['https://example.com'], '/tmp').android).toBeUndefined();
  expect(() => normalizePaneLaunch(['device', 'view', 'phone', '--max-size=-1'], '/tmp')).toThrow();
});

test('launch parsing preserves URL and independent pane flags', () => {
  const first = normalizePaneLaunch(
    [
      '--overlay',
      '--design',
      '--transparent',
      '--no-paint',
      '--source-window-id=42',
      'example.com',
    ],
    '/tmp',
  );
  expect(first.url).toBe('https://example.com');
  expect(first.sourceWindowId).toBe('42');
  expect(first.settings).toEqual({
    overlay: true,
    design: true,
    transparent: true,
    noPaint: true,
    debugPaint: false,
  });
  expect(normalizePaneLaunch([], '/tmp').settings.overlay).toBe(false);
});

test('the DevTools port stays off unless requested', () => {
  expect(normalizePaneLaunch(['https://example.com'], '/tmp').debugPort).toBe('disabled');
  expect(
    normalizePaneLaunch(['--debug-port=9222', 'https://example.com'], '/tmp').debugPort,
  ).toBe('9222');
});
