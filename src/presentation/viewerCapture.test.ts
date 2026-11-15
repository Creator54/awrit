import { afterEach, beforeEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { finalizeViewerCapture, loadFrozenCapture } from './collaborativeCapture';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
let dir: string;
const original = process.env.XDG_DATA_HOME;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-viewer-capture-'));
  process.env.XDG_DATA_HOME = dir;
});
afterEach(() => {
  if (original === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = original;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('finalizes supplied viewer bytes without recapturing or changing the legacy receipt', () => {
  const capture = finalizeViewerCapture(png, { target: 'https://example.test/', isAdb: false });
  expect(capture.width).toBe(2);
  expect(capture.height).toBe(2);
  expect(capture.sha256).toBe(createHash('sha256').update(png).digest('hex'));
  expect(fs.readFileSync(capture.imagePath)).toEqual(png);
  expect(fs.statSync(capture.imagePath).mode & 0o777).toBe(0o400);
  expect(loadFrozenCapture(capture.id)).toEqual(capture);
  expect(capture.marker).toBe(`![awrit:Web capture](${capture.imagePath})`);
  expect(capture.author).toBe('user');
});

test('rejects invalid or oversized viewer bytes before storing evidence', () => {
  const source = { target: 'device-serial', isAdb: true };
  expect(() => finalizeViewerCapture(Buffer.alloc(0), source)).toThrow();
  expect(() => finalizeViewerCapture(Buffer.alloc(16 * 1024 * 1024 + 1), source)).toThrow('16 MiB');
  expect(() => finalizeViewerCapture(null as any, source)).toThrow('16 MiB');
  expect(() => finalizeViewerCapture(png, null as any)).toThrow('Invalid viewer capture source');
  expect(() => finalizeViewerCapture(png, { target: '', isAdb: false })).toThrow();
  expect(() => finalizeViewerCapture(png, { target: 'x'.repeat(8193), isAdb: false })).toThrow();
  expect(() => finalizeViewerCapture(png, { target: 'device-serial', isAdb: 'yes' as any })).toThrow(
    'Invalid viewer capture source',
  );
});
