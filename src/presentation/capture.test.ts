import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CaptureError,
  captureSnapshot,
  MAX_VIEWPORT_SIDE,
  resolveElectronFromLauncher,
  validateViewport,
  verifyPngHeaderAndDimensions,
} from './capture';
import {
  isAllowedNavigation,
  isAllowedSubresource,
  parseCaptureMainArgs,
  writePngOutputSecurely,
} from './captureMain';
import type { PresentationTarget } from './target';

let testDir = '';

beforeEach(() => {
  testDir = mkdtempSync(path.join(os.tmpdir(), 'awrit-capture-test-'));
});

afterEach(() => {
  try {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  } catch {}
});

function createValidPngBuffer(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const ihdrChunk = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x0d]),
    Buffer.from('IHDR', 'ascii'),
    ihdr,
    Buffer.alloc(4),
  ]);

  const iendChunk = Buffer.from([
    0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  return Buffer.concat([signature, ihdrChunk, iendChunk]);
}

function createFakeElectronScript(body: string): string {
  const scriptPath = path.join(testDir, `fake-electron-${Math.random().toString(36).slice(2)}.js`);
  writeFileSync(scriptPath, body, 'utf8');
  return scriptPath;
}

function createDummyExecutable(scriptPath: string): string {
  const binPath = path.join(testDir, `fake-bin-${Math.random().toString(36).slice(2)}`);
  const content = `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`;
  writeFileSync(binPath, content, { mode: 0o755 });
  return binPath;
}

describe('validateViewport', () => {
  test('returns default 1280x800 when viewport is undefined', () => {
    expect(validateViewport(undefined)).toEqual({ width: 1280, height: 800 });
  });

  test('accepts valid viewport dimensions', () => {
    expect(validateViewport({ width: 1920, height: 1080 })).toEqual({
      width: 1920,
      height: 1080,
    });
    expect(validateViewport({ width: 4096, height: 2048 })).toEqual({
      width: 4096,
      height: 2048,
    });
  });

  test('rejects negative or zero dimensions', () => {
    expect(() => validateViewport({ width: 0, height: 800 })).toThrow(CaptureError);
    expect(() => validateViewport({ width: 100, height: -50 })).toThrow(CaptureError);
  });

  test('rejects dimensions exceeding MAX_VIEWPORT_SIDE (4096)', () => {
    expect(() => validateViewport({ width: MAX_VIEWPORT_SIDE + 1, height: 800 })).toThrow(
      CaptureError,
    );
    expect(() => validateViewport({ width: 800, height: MAX_VIEWPORT_SIDE + 1 })).toThrow(
      CaptureError,
    );
  });

  test('rejects dimensions exceeding MAX_VIEWPORT_PIXELS (8MP)', () => {
    expect(() => validateViewport({ width: 4000, height: 3000 })).toThrow(CaptureError);
  });
});

describe('verifyPngHeaderAndDimensions', () => {
  test('verifies valid PNG file and dimensions', () => {
    const pngPath = path.join(testDir, 'valid.png');
    writeFileSync(pngPath, createValidPngBuffer(800, 600));
    expect(() => verifyPngHeaderAndDimensions(pngPath, 800, 600)).not.toThrow();
  });

  test('rejects corrupted or truncated PNG header', () => {
    const shortPath = path.join(testDir, 'short.png');
    writeFileSync(shortPath, Buffer.from('SHORT'));
    expect(() => verifyPngHeaderAndDimensions(shortPath, 800, 600)).toThrow(/header too short/);

    const corruptPath = path.join(testDir, 'corrupt.png');
    writeFileSync(corruptPath, Buffer.alloc(24, 0x41));
    expect(() => verifyPngHeaderAndDimensions(corruptPath, 800, 600)).toThrow(
      /Output file is not a valid PNG image/,
    );
  });

  test('rejects dimension mismatch', () => {
    const pngPath = path.join(testDir, 'mismatch.png');
    writeFileSync(pngPath, createValidPngBuffer(800, 600));
    expect(() => verifyPngHeaderAndDimensions(pngPath, 1024, 768)).toThrow(
      /PNG dimensions mismatch/,
    );
  });
});

describe('writePngOutputSecurely', () => {
  test('exclusive create: rejects pre-existing file without overwrite flag without truncating', () => {
    const targetFile = path.join(testDir, 'existing.png');
    writeFileSync(targetFile, 'INITIAL_CONTENT');

    const newPng = createValidPngBuffer(100, 100);
    expect(() => writePngOutputSecurely(targetFile, newPng, false)).toThrow(/already exists/);
    expect(readFileSync(targetFile, 'utf8')).toBe('INITIAL_CONTENT');
  });

  test('atomic overwrite: replaces existing file cleanly', () => {
    const targetFile = path.join(testDir, 'overwrite.png');
    writeFileSync(targetFile, 'OLD_CONTENT');

    const newPng = createValidPngBuffer(100, 100);
    writePngOutputSecurely(targetFile, newPng, true);
    expect(readFileSync(targetFile)).toEqual(newPng);
  });
});

describe('captureMain policies and parsing', () => {
  test('parseCaptureMainArgs parses strict config JSON', () => {
    const config = {
      target: { kind: 'url', url: 'https://example.com' },
      out: '/tmp/test.png',
      viewport: { width: 800, height: 600 },
      overwrite: true,
      loadTimeoutMs: 10000,
      fontTimeoutMs: 1500,
      waitMs: 500,
      waitSelector: '#content',
    };
    const parsed = parseCaptureMainArgs(['--config-json', JSON.stringify(config)]);
    expect(parsed).toEqual(config as any);
  });

  test('parseCaptureMainArgs rejects negative or malformed viewport dimensions', () => {
    const badConfig = {
      target: { kind: 'url', url: 'https://example.com' },
      out: '/tmp/test.png',
      viewport: { width: -100, height: 600 },
    };
    expect(parseCaptureMainArgs(['--config-json', JSON.stringify(badConfig)])).toBeNull();
  });

  test('isAllowedNavigation enforces security policies', () => {
    const fileTarget: PresentationTarget = {
      kind: 'file',
      path: '/home/user/doc.html',
      url: 'file:///home/user/doc.html',
    };
    expect(isAllowedNavigation(fileTarget, 'file:///home/user/doc.html#section')).toBe(true);
    expect(isAllowedNavigation(fileTarget, 'file:///home/user/other.html')).toBe(false);
    expect(isAllowedNavigation(fileTarget, 'https://example.com')).toBe(false);

    const urlTarget: PresentationTarget = {
      kind: 'url',
      url: 'https://example.com/docs',
    };
    expect(isAllowedNavigation(urlTarget, 'https://example.com/login')).toBe(true);
    expect(isAllowedNavigation(urlTarget, 'http://sub.example.com/page')).toBe(true);
    expect(isAllowedNavigation(urlTarget, 'file:///etc/passwd')).toBe(false);
    expect(isAllowedNavigation(urlTarget, 'javascript:alert(1)')).toBe(false);
    expect(isAllowedNavigation(urlTarget, 'https://user:pass@example.com')).toBe(false);
  });

  test('isAllowedSubresource blocks symlink escapes and out-of-bounds files', () => {
    const assetsDir = path.join(testDir, 'assets');
    const secretDir = path.join(testDir, 'secret');
    mkdirSync(assetsDir, { recursive: true });
    mkdirSync(secretDir, { recursive: true });

    const htmlFile = path.join(assetsDir, 'page.html');
    writeFileSync(htmlFile, '<h1>Test</h1>');
    const siblingImage = path.join(assetsDir, 'img.png');
    writeFileSync(siblingImage, 'PNG');
    const secretFile = path.join(secretDir, 'secret.txt');
    writeFileSync(secretFile, 'CONFIDENTIAL');

    // Symlink inside assets pointing outside to secretFile
    const symlinkEscape = path.join(assetsDir, 'escapelink.png');
    symlinkSync(secretFile, symlinkEscape);

    const fileTarget: PresentationTarget = {
      kind: 'file',
      path: realpathSync(htmlFile),
      url: `file://${realpathSync(htmlFile)}`,
    };

    // Valid sibling file
    expect(isAllowedSubresource(fileTarget, `file://${siblingImage}`)).toBe(true);

    // Symlink escaping directory must be blocked
    expect(isAllowedSubresource(fileTarget, `file://${symlinkEscape}`)).toBe(false);

    // Direct parent traversal must be blocked
    expect(isAllowedSubresource(fileTarget, `file://${secretFile}`)).toBe(false);
  });
});

describe('captureSnapshot with fake executable', () => {
  test('successfully executes snapshot and verifies real PNG signature', async () => {
    const fakeScript = createFakeElectronScript(`
      const fs = require('fs');
      const idx = process.argv.indexOf('--config-json');
      const config = JSON.parse(process.argv[idx + 1]);

      // Generate valid PNG buffer
      const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const ihdr = Buffer.alloc(13);
      ihdr.writeUInt32BE(config.viewport.width, 0);
      ihdr.writeUInt32BE(config.viewport.height, 4);
      ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

      const ihdrChunk = Buffer.concat([
        Buffer.from([0x00, 0x00, 0x00, 0x0d]),
        Buffer.from('IHDR', 'ascii'),
        ihdr,
        Buffer.alloc(4)
      ]);
      const iendChunk = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);
      const png = Buffer.concat([signature, ihdrChunk, iendChunk]);

      fs.writeFileSync(config.out, png);
      const payload = {
        __awrit_capture_result__: true,
        success: true,
        outPath: config.out,
        width: config.viewport.width,
        height: config.viewport.height,
        byteLength: png.length
      };
      process.stdout.write(JSON.stringify(payload) + '\\n');
      process.exit(0);
    `);
    const fakeBin = createDummyExecutable(fakeScript);
    const outPng = path.join(testDir, 'output.png');

    const result = await captureSnapshot({
      target: 'https://example.com',
      out: outPng,
      electronPath: fakeBin,
      entryPath: fakeScript,
      viewport: { width: 1024, height: 768 },
    });

    expect(result.outPath).toBe(outPng);
    expect(result.width).toBe(1024);
    expect(result.height).toBe(768);
    expect(existsSync(outPng)).toBe(true);
  });

  test('rejects pre-existing output file before spawning executable', async () => {
    const outPng = path.join(testDir, 'existing.png');
    writeFileSync(outPng, 'OLD_CONTENT');

    const fakeScript = createFakeElectronScript('process.exit(0);');
    const fakeBin = createDummyExecutable(fakeScript);

    await expect(
      captureSnapshot({
        target: 'https://example.com',
        out: outPng,
        overwrite: false,
        electronPath: fakeBin,
        entryPath: fakeScript,
      }),
    ).rejects.toThrow(/Output file already exists/);

    expect(readFileSync(outPng, 'utf8')).toBe('OLD_CONTENT');
  });

  test('escalates to KILL if child process ignores SIGTERM on timeout', async () => {
    const fakeScript = createFakeElectronScript(`
      // Ignore SIGTERM
      process.on('SIGTERM', () => {});
      setTimeout(() => {}, 10000);
    `);
    const fakeBin = createDummyExecutable(fakeScript);
    const outPng = path.join(testDir, 'hang.png');

    const promise = captureSnapshot({
      target: 'https://example.com',
      out: outPng,
      electronPath: fakeBin,
      entryPath: fakeScript,
      timeoutMs: 150,
    });

    await expect(promise).rejects.toThrow(/Capture timed out after 150ms/);
  });

  test('rejects non-positive or non-finite timeouts', async () => {
    const outPng = path.join(testDir, 'timeout_bad.png');
    await expect(
      captureSnapshot({
        target: 'https://example.com',
        out: outPng,
        electronPath: '/bin/true',
        entryPath: '/bin/true',
        timeoutMs: -50,
      }),
    ).rejects.toThrow(/timeoutMs must be a positive number/);

    await expect(
      captureSnapshot({
        target: 'https://example.com',
        out: outPng,
        electronPath: '/bin/true',
        entryPath: '/bin/true',
        timeoutMs: Number.NaN,
      }),
    ).rejects.toThrow(/timeoutMs must be a positive number/);
  });

  test('dynamically extracts electron from launcher script', () => {
    const mockLauncher = path.join(testDir, 'mock-awrit');
    writeFileSync(
      mockLauncher,
      '#!/bin/sh\nexport LD_LIBRARY_PATH="/nix/store/mock-glib/lib"\nexec "/nix/store/mock-electron/bin/electron" "$@"\n',
    );
    const resolved = resolveElectronFromLauncher(mockLauncher);
    expect(resolved.electronPath).toBe('/nix/store/mock-electron/bin/electron');
    expect(resolved.ldLibraryPath).toBe('/nix/store/mock-glib/lib');
  });
});
