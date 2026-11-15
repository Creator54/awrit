import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderCodeTarget } from './codePage';
import {
  createFrozenCapture,
  formatMarkerCaption,
  isValidCaptureId,
  listFrozenCaptures,
  loadFrozenCapture,
  updateCaptureComment,
  normalizeRegionBox,
  sanitizeCaptureComment,
  updateCaptureSentRevisions,
} from './collaborativeCapture';

// Minimal 2x2 valid PNG fixture
const VALID_2X2_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const originalAppData = process.env.XDG_DATA_HOME;
let tempDir: string;

describe('collaborativeCapture', () => {
  beforeEach(() => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-test-capture-')));
    process.env.XDG_DATA_HOME = tempDir;
  });

  afterEach(() => {
    if (originalAppData !== undefined) {
      process.env.XDG_DATA_HOME = originalAppData;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('targetless capture pins the current live viewer instead of loading another page', async () => {
    const tools = await import('./toolClient');
    const sockets = await import('../ipc/socketServer');
    const status = spyOn(tools, 'readStatus').mockResolvedValue({ viewer: true, viewers: [
      { paneId: 'current-pane', url: 'https://example.test/scene', loading: false, designMode: false },
    ], next: '' });
    const alive = spyOn(sockets, 'isSocketAlive').mockResolvedValue(true);
    const live = spyOn(tools, 'request').mockImplementation(async (_socket, type, payload) => {
      expect(type).toBe('capture:request');
      expect(payload.paneId).toBe('current-pane');
      return { base64: VALID_2X2_PNG.toString('base64'), url: 'https://example.test/scene', inputWidth: 1, inputHeight: 1 };
    });
    try {
      const capture = await createFrozenCapture({ sourceWindowId: 123 });
      expect(capture.target).toBe('https://example.test/scene');
      expect(capture.captureOrigin).toEqual({ kind: 'live-viewer', paneId: 'current-pane' });
      expect(capture.inputCoordinates).toEqual({ space: 'viewer', width: 1, height: 1, scaleX: 0.5, scaleY: 0.5 });
      expect(status).toHaveBeenCalledWith('123');
      status.mockResolvedValueOnce({ viewer: true, viewers: [
        { paneId: 'one', url: 'https://one.test', loading: false, designMode: false },
        { paneId: 'two', url: 'https://two.test', loading: false, designMode: false },
      ], next: '' });
      await expect(createFrozenCapture({ sourceWindowId: 123 })).rejects.toThrow('Several viewers');
      expect(live).toHaveBeenCalledTimes(1);
      live.mockRejectedValue(new Error('Live capture failed'));
      await expect(createFrozenCapture({ sourceWindowId: 123 })).rejects.toThrow('Live capture failed');
    } finally { status.mockRestore(); alive.mockRestore(); live.mockRestore(); }
  });

  test('targetless capture of an Android viewer keeps device pixels and the device target', async () => {
    const tools = await import('./toolClient');
    const sockets = await import('../ipc/socketServer');
    const status = spyOn(tools, 'readStatus').mockResolvedValue({ viewer: true, viewers: [
      { paneId: 'phone-pane', url: 'http://127.0.0.1:1/', loading: false, designMode: false },
    ], next: '' });
    const alive = spyOn(sockets, 'isSocketAlive').mockResolvedValue(true);
    const live = spyOn(tools, 'request').mockResolvedValue(
      { base64: VALID_2X2_PNG.toString('base64'), url: '127.0.0.1:5556', isAdb: true, paneId: 'phone-pane' });
    try {
      const capture = await createFrozenCapture({ sourceWindowId: 123 });
      expect(capture.isAdb).toBe(true);
      expect(capture.target).toBe('127.0.0.1:5556');
      expect(capture.source).toBeUndefined();
      expect(capture.inputCoordinates).toBeUndefined();
    } finally { status.mockRestore(); alive.mockRestore(); live.mockRestore(); }
  });

  test('targetless capture reads a remote viewer over its published socket', async () => {
    const tools = await import('./toolClient');
    const sockets = await import('../ipc/socketServer');
    const registry = await import('../remote/registry');
    const status = spyOn(tools, 'readStatus').mockResolvedValue({ viewer: true, viewers: [
      { paneId: 'remote-1', url: 'https://example.test/scene', loading: false, designMode: false },
    ], next: '' });
    const alive = spyOn(sockets, 'isSocketAlive').mockResolvedValue(false);
    const find = spyOn(registry, 'findRemotePane').mockReturnValue({
      session: 'remote-1', host: 'phoenix', socket: '/tmp/remote-1.sock', sourceWindowId: '123', pid: process.pid,
    });
    const remote = spyOn(tools, 'request').mockImplementation(async (socket, type, payload) => {
      expect(socket).toBe('/tmp/remote-1.sock');
      expect(type).toBe('capture:request');
      expect(payload).toEqual({ waitMs: 50, waitSelector: '#ready' });
      return { base64: VALID_2X2_PNG.toString('base64'), url: 'https://example.test/scene', inputWidth: 1, inputHeight: 1 };
    });
    try {
      const capture = await createFrozenCapture({ sourceWindowId: 123, waitMs: 50, waitSelector: '#ready' });
      expect(find).toHaveBeenCalledWith({ windowId: '123', paneId: 'remote-1' });
      expect(capture.captureOrigin).toEqual({ kind: 'live-viewer', paneId: 'remote-1' });
      expect(capture.target).toBe('https://example.test/scene');
    } finally {
      status.mockRestore();
      alive.mockRestore();
      find.mockRestore();
      remote.mockRestore();
    }
  });

  test('targetless capture falls back to a remote viewer when the local owner has none', async () => {
    const tools = await import('./toolClient');
    const sockets = await import('../ipc/socketServer');
    const registry = await import('../remote/registry');
    const status = spyOn(tools, 'readStatus').mockResolvedValue({ viewer: true, viewers: [
      { paneId: 'remote-1', url: 'https://example.test/scene', loading: false, designMode: false },
    ], next: '' });
    const alive = spyOn(sockets, 'isSocketAlive').mockResolvedValue(true);
    const find = spyOn(registry, 'findRemotePane').mockReturnValue({
      session: 'remote-1', host: 'phoenix', socket: '/tmp/remote-1.sock', sourceWindowId: '123', pid: process.pid,
    });
    const remote = spyOn(tools, 'request').mockImplementation(async (socket, _type, payload) => {
      if (socket !== '/tmp/remote-1.sock') throw new Error('No matching active viewer pane');
      expect(payload).toEqual({});
      return { base64: VALID_2X2_PNG.toString('base64'), url: 'https://example.test/scene' };
    });
    try {
      const capture = await createFrozenCapture({ sourceWindowId: 123 });
      expect(capture.captureOrigin).toEqual({ kind: 'live-viewer', paneId: 'remote-1' });
    } finally {
      status.mockRestore();
      alive.mockRestore();
      find.mockRestore();
      remote.mockRestore();
    }
  });

  test('source history survives generated page cleanup', async () => {
    const file = path.join(tempDir, 'original.ts');
    fs.writeFileSync(file, 'const original = 1;');
    const page = await renderCodeTarget(file);
    const captureModule = await import('./capture');
    const spy = spyOn(captureModule, 'captureSnapshot').mockImplementation(async (options) => {
      fs.rmSync(path.join(path.dirname(page), 'source.txt'));
      fs.writeFileSync(options.out, VALID_2X2_PNG);
      return { outPath: options.out, width: 2, height: 2 };
    });
    let capture: Awaited<ReturnType<typeof createFrozenCapture>>;
    try { capture = await createFrozenCapture({ target: pathToFileURL(page).href, entryPath: '/unused' }); }
    finally { spy.mockRestore(); }
    fs.rmSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(file, 'changed');
    expect(loadFrozenCapture(capture.id)?.source).toMatchObject({ path: file, text: 'const original = 1;' });
  });

  test('history skips oversized and symlinked metadata and fills limit with valid captures', () => {
    const root = path.join(tempDir, 'awrit', 'captures');
    fs.mkdirSync(root, { recursive: true });
    const good = 'cap-111111111111';
    fs.writeFileSync(path.join(root, `${good}.json`), JSON.stringify({ id: good }));
    fs.writeFileSync(path.join(root, 'cap-222222222222.json'), ' '.repeat(8 * 1024 * 1024 + 1));
    const outside = path.join(tempDir, 'outside.json');
    fs.writeFileSync(outside, JSON.stringify({ id: 'cap-333333333333' }));
    fs.symlinkSync(outside, path.join(root, 'cap-333333333333.json'));
    expect(loadFrozenCapture('cap-222222222222')).toBeNull();
    expect(loadFrozenCapture('cap-333333333333')).toBeNull();
    expect(listFrozenCaptures(1).map(item => item.id)).toEqual([good]);
  });

  test('isValidCaptureId strictly enforces cap-[a-f0-9]{12} and rejects path traversal', () => {
    expect(isValidCaptureId('cap-0123456789ab')).toBe(true);
    expect(isValidCaptureId('../../etc/passwd')).toBe(false);
    expect(isValidCaptureId('cap-invalid')).toBe(false);
    expect(isValidCaptureId('')).toBe(false);
    expect(isValidCaptureId(null)).toBe(false);
  });

  test('normalizeRegionBox normalizes reversed drag coordinates and checks bitmap bounds', () => {
    // Normal drag
    expect(normalizeRegionBox({ x: 10, y: 20, width: 30, height: 40 }, 100, 100)).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });

    // Reversed drag: dragging from x=40 back to x=10 (width=-30)
    expect(normalizeRegionBox({ x: 40, y: 60, width: -30, height: -40 }, 100, 100)).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });

    // Subpixel rounding
    expect(normalizeRegionBox({ x: 10.4, y: 20.6, width: 29.8, height: 40.2 }, 100, 100)).toEqual({
      x: 10,
      y: 21,
      width: 30,
      height: 40,
    });

    // Rejection of zero area or out of bounds
    expect(() => normalizeRegionBox({ x: 0, y: 0, width: 0, height: 10 }, 100, 100)).toThrow(
      'Region width and height must be strictly positive',
    );
    expect(() => normalizeRegionBox({ x: -5, y: 0, width: 10, height: 10 }, 100, 100)).toThrow(
      'outside bitmap bounds',
    );
    expect(() => normalizeRegionBox({ x: 90, y: 90, width: 20, height: 20 }, 100, 100)).toThrow(
      'exceeds bitmap bounds',
    );
  });

  test('sanitizeCaptureComment strips control characters and formatMarkerCaption cleans markdown', () => {
    expect(sanitizeCaptureComment('Valid comment\nwith newline')).toBe(
      'Valid comment\nwith newline',
    );
    // Control characters stripped
    expect(sanitizeCaptureComment('Bad\x00\x07text')).toBe('Badtext');

    // formatMarkerCaption removes brackets and collapses newlines
    expect(formatMarkerCaption('Issue [P1] here\nSecond line')).toBe('Issue P1 here Second line');
    expect(formatMarkerCaption('')).toBe('capture');
  });

  test('createFrozenCapture captures and saves immutable PNG with sha256 and metadata', async () => {
    // Mock captureDeviceScreenshot
    mock.module('../adb/androidManager', () => ({
      getAdbSerialForDevice: (s: string) => s,
      listConnectedAdbDevices: () => Promise.resolve(['127.0.0.1:5558']),
      captureDeviceScreenshot: () =>
        Promise.resolve({ ok: true, base64: VALID_2X2_PNG.toString('base64') }),
    }));

    // Without a stub, a real viewer open for this KITTY_WINDOW_ID would be captured instead.
    const tools = await import('./toolClient');
    const status = spyOn(tools, 'readStatus').mockResolvedValue({ viewer: false, viewers: [], next: '' });
    const capture = await createFrozenCapture({
      region: { x: 0, y: 0, width: 2, height: 2 },
      comment: 'Test comment [alert]',
      author: 'user',
    }).finally(() => status.mockRestore());

    expect(isValidCaptureId(capture.id)).toBe(true);
    expect(capture.width).toBe(2);
    expect(capture.height).toBe(2);
    expect(capture.sha256.length).toBe(64);
    expect(fs.existsSync(capture.imagePath)).toBe(true);
    expect(capture.caption).toBe('Test comment alert');
    expect(capture.marker).toContain(`![awrit:Test comment alert](${capture.imagePath})`);

    // Verify loading by ID
    const loaded = loadFrozenCapture(capture.id);
    expect(loaded).not.toBeNull();
    expect(loaded?.id).toBe(capture.id);
    expect(loaded?.comment).toBe('Test comment [alert]');

    // Verify list
    const list = listFrozenCaptures();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list[0].id).toBe(capture.id);
  });

  test('sent revisions accumulate so reverting to earlier sent text stays sent', () => {
    const dir = path.join(tempDir, 'awrit', 'captures');
    fs.mkdirSync(dir, { recursive: true });
    const id = 'cap-cccccccccccc';
    const png = path.join(dir, `${id}.png`);
    fs.writeFileSync(png, VALID_2X2_PNG);
    const saved = { id, timestamp: 1, target: 'https://x.test/', isAdb: false, imagePath: png, width: 2, height: 2, sha256: 'abc', caption: 'c', marker: 'm', author: 'user' as const };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(saved), { mode: 0o400 });
    updateCaptureSentRevisions(id, { 'ann-1': ['rev-a'] });
    updateCaptureSentRevisions(id, { 'ann-1': ['rev-b', 'rev-a'], 'ann-2': ['rev-x'] });
    expect(loadFrozenCapture(id)?.sentRevisions).toEqual({ 'ann-1': ['rev-a', 'rev-b'], 'ann-2': ['rev-x'] });
  });

  test('updating a saved capture note rewrites only comment, caption and marker', () => {
    const dir = path.join(tempDir, 'awrit', 'captures');
    fs.mkdirSync(dir, { recursive: true });
    const id = 'cap-aaaaaaaaaaaa';
    const png = path.join(dir, `${id}.png`);
    fs.writeFileSync(png, VALID_2X2_PNG);
    const old = { id, timestamp: 1, target: 'https://x.test/', isAdb: false, imagePath: png, width: 2, height: 2, sha256: 'abc', comment: 'old', caption: 'old', marker: `![awrit:old](${png})`, author: 'user' as const, source: { path: '/p', sha256: 's', text: 't' } };
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(old), { mode: 0o400 });
    const next = updateCaptureComment(id, 'new [note]\u0007');
    expect(next?.comment).toBe('new [note]');
    expect(next?.caption).toBe('new note');
    expect(next?.marker).toBe(`![awrit:new note](${png})`);
    expect(loadFrozenCapture(id)).toEqual({ ...old, comment: 'new [note]', caption: 'new note', marker: `![awrit:new note](${png})` });
    expect(updateCaptureComment('../etc', 'x')).toBeNull();
    expect(updateCaptureComment('cap-bbbbbbbbbbbb', 'x')).toBeNull();
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
