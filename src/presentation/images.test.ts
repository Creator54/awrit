import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import {
  assertTerminalEligibility,
  buildIcatArgs,
  calculateImageFit,
  captureIcatGraphics,
  detectImageSignature,
  ImagePresentationError,
  MAX_IMAGE_FILE_SIZE,
  presentInlineImage,
  validateImageFile,
  validateTerminalDimensions,
  writeToStreamWithBackpressure,
} from './images';

const testDir = path.join(
  os.tmpdir(),
  `images-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
);

beforeAll(() => {
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function createDummyImage(fileName: string, signature: Buffer, totalSize = 64): string {
  const filePath = path.join(testDir, fileName);
  const data = Buffer.alloc(totalSize);
  signature.copy(data, 0);
  writeFileSync(filePath, data);
  return filePath;
}

describe('images', () => {
  describe('detectImageSignature', () => {
    test('detects PNG signature', () => {
      const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
      expect(detectImageSignature(pngHeader)).toBe('png');
    });

    test('detects JPEG signature', () => {
      const jpegHeader = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
      expect(detectImageSignature(jpegHeader)).toBe('jpeg');
    });

    test('detects GIF87a and GIF89a signatures', () => {
      const gif87 = Buffer.from('GIF87a');
      const gif89 = Buffer.from('GIF89a');
      expect(detectImageSignature(gif87)).toBe('gif');
      expect(detectImageSignature(gif89)).toBe('gif');
    });

    test('detects WebP signature', () => {
      const webpHeader = Buffer.from('RIFF\x20\x00\x00\x00WEBPVP8 ');
      expect(detectImageSignature(webpHeader)).toBe('webp');
    });

    test('rejects other formats and unsupported text / HTML signatures', () => {
      // Formats explicitly scoped out (no QOI, BMP, TIFF)
      expect(detectImageSignature(Buffer.from('BM\x00\x00\x00\x00'))).toBeNull();
      expect(detectImageSignature(Buffer.from([0x49, 0x49, 0x2a, 0x00]))).toBeNull();
      expect(detectImageSignature(Buffer.from('qoif\x00\x00\x00\x10'))).toBeNull();
      expect(detectImageSignature(Buffer.from('Hello world!'))).toBeNull();
      expect(detectImageSignature(Buffer.from('<!DOCTYPE html>'))).toBeNull();
      expect(detectImageSignature(Buffer.from('{"json":true}'))).toBeNull();
      expect(detectImageSignature(Buffer.alloc(0))).toBeNull();
    });
  });

  describe('validateImageFile', () => {
    test('validates valid PNG file', () => {
      const pngPath = createDummyImage(
        'valid.png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      const result = validateImageFile(pngPath);
      expect(result.format).toBe('png');
      expect(result.byteLength).toBe(64);
      expect(result.canonicalPath).toBe(realpathSync(pngPath));
    });

    test('rejects non-existent file', () => {
      expect(() => validateImageFile(path.join(testDir, 'does-not-exist.png'))).toThrow(
        ImagePresentationError,
      );
      try {
        validateImageFile(path.join(testDir, 'does-not-exist.png'));
      } catch (err) {
        expect((err as ImagePresentationError).code).toBe('FILE_NOT_FOUND');
      }
    });

    test('rejects directory target', () => {
      expect(() => validateImageFile(testDir)).toThrow(ImagePresentationError);
      try {
        validateImageFile(testDir);
      } catch (err) {
        expect((err as ImagePresentationError).code).toBe('NOT_REGULAR_FILE');
      }
    });

    test('rejects empty file', () => {
      const emptyPath = path.join(testDir, 'empty.png');
      writeFileSync(emptyPath, Buffer.alloc(0));
      expect(() => validateImageFile(emptyPath)).toThrow(ImagePresentationError);
      try {
        validateImageFile(emptyPath);
      } catch (err) {
        expect((err as ImagePresentationError).code).toBe('EMPTY_FILE');
      }
    });

    test('rejects file exceeding 16 MiB', () => {
      const largePath = path.join(testDir, 'large.png');
      const fd = require('node:fs').openSync(largePath, 'w');
      require('node:fs').ftruncateSync(fd, MAX_IMAGE_FILE_SIZE + 1024);
      require('node:fs').closeSync(fd);

      expect(() => validateImageFile(largePath)).toThrow(ImagePresentationError);
      try {
        validateImageFile(largePath);
      } catch (err) {
        expect((err as ImagePresentationError).code).toBe('FILE_TOO_LARGE');
      }
    });

    test('rejects file with invalid signature', () => {
      const txtPath = path.join(testDir, 'not-image.png');
      writeFileSync(txtPath, Buffer.from('Not a real image file! Just text.'));
      expect(() => validateImageFile(txtPath)).toThrow(ImagePresentationError);
      try {
        validateImageFile(txtPath);
      } catch (err) {
        expect((err as ImagePresentationError).code).toBe('INVALID_IMAGE_SIGNATURE');
      }
    });
  });

  describe('assertTerminalEligibility', () => {
    test('accepts valid caller-owned TTY terminal in Kitty window', () => {
      const windowId = assertTerminalEligibility({
        ownedTerminal: true,
        stdout: { isTTY: true },
        env: { KITTY_WINDOW_ID: '42' },
      });
      expect(windowId).toBe(42);
    });

    test('rejects when ownedTerminal is not true', () => {
      expect(() =>
        assertTerminalEligibility({
          ownedTerminal: false,
          stdout: { isTTY: true },
          env: { KITTY_WINDOW_ID: '42' },
        }),
      ).toThrow(ImagePresentationError);

      expect(() =>
        assertTerminalEligibility({
          stdout: { isTTY: true },
          env: { KITTY_WINDOW_ID: '42' },
        }),
      ).toThrow(ImagePresentationError);
    });

    test('rejects when stdout is non-TTY', () => {
      expect(() =>
        assertTerminalEligibility({
          ownedTerminal: true,
          stdout: { isTTY: false },
          env: { KITTY_WINDOW_ID: '42' },
        }),
      ).toThrow(ImagePresentationError);
      try {
        assertTerminalEligibility({
          ownedTerminal: true,
          stdout: { isTTY: false },
          env: { KITTY_WINDOW_ID: '42' },
        });
      } catch (err) {
        expect((err as ImagePresentationError).code).toBe('NON_TTY');
      }
    });

    test('rejects when KITTY_WINDOW_ID is missing or invalid', () => {
      expect(() =>
        assertTerminalEligibility({
          ownedTerminal: true,
          stdout: { isTTY: true },
          env: {},
        }),
      ).toThrow(ImagePresentationError);

      expect(() =>
        assertTerminalEligibility({
          ownedTerminal: true,
          stdout: { isTTY: true },
          env: { KITTY_WINDOW_ID: '0' },
        }),
      ).toThrow(ImagePresentationError);

      expect(() =>
        assertTerminalEligibility({
          ownedTerminal: true,
          stdout: { isTTY: true },
          env: { KITTY_WINDOW_ID: 'not-a-number' },
        }),
      ).toThrow(ImagePresentationError);
    });

    test('rejects when multiplexer is detected (TMUX, STY, ZELLIJ)', () => {
      for (const muxVar of ['TMUX', 'STY', 'ZELLIJ']) {
        expect(() =>
          assertTerminalEligibility({
            ownedTerminal: true,
            stdout: { isTTY: true },
            env: { KITTY_WINDOW_ID: '42', [muxVar]: '1' },
          }),
        ).toThrow(ImagePresentationError);
        try {
          assertTerminalEligibility({
            ownedTerminal: true,
            stdout: { isTTY: true },
            env: { KITTY_WINDOW_ID: '42', [muxVar]: '1' },
          });
        } catch (err) {
          expect((err as ImagePresentationError).code).toBe('MULTIPLEXER_DETECTED');
        }
      }
    });

    test('rejects when agent harness is detected (CLAUDE_CODE, CODEX, etc.)', () => {
      const agentVars = [
        'CLAUDE_CODE',
        'CLAUDE_SESSION_ID',
        'CLAUDE_AGENT_ID',
        'CODEX',
        'OPENCODE',
      ];
      for (const agentVar of agentVars) {
        expect(() =>
          assertTerminalEligibility({
            ownedTerminal: true,
            stdout: { isTTY: true },
            env: { KITTY_WINDOW_ID: '42', [agentVar]: '1' },
          }),
        ).toThrow(ImagePresentationError);
        try {
          assertTerminalEligibility({
            ownedTerminal: true,
            stdout: { isTTY: true },
            env: { KITTY_WINDOW_ID: '42', [agentVar]: '1' },
          });
        } catch (err) {
          expect((err as ImagePresentationError).code).toBe('AGENT_DETECTED');
        }
      }
    });
  });

  describe('validateTerminalDimensions & calculateImageFit', () => {
    test('validates valid terminal dimensions', () => {
      expect(() =>
        validateTerminalDimensions({
          columns: 120,
          rows: 40,
          pixelWidth: 1920,
          pixelHeight: 1080,
        }),
      ).not.toThrow();
    });

    test('rejects non-positive or non-integer terminal dimensions', () => {
      expect(() =>
        validateTerminalDimensions({
          columns: 0,
          rows: 40,
          pixelWidth: 1920,
          pixelHeight: 1080,
        }),
      ).toThrow(ImagePresentationError);

      expect(() =>
        validateTerminalDimensions({
          columns: 120,
          rows: -1,
          pixelWidth: 1920,
          pixelHeight: 1080,
        }),
      ).toThrow(ImagePresentationError);

      expect(() =>
        validateTerminalDimensions({
          columns: 120,
          rows: 40,
          pixelWidth: 1920.5,
          pixelHeight: 1080,
        }),
      ).toThrow(ImagePresentationError);
    });

    test('calculates default fit when no dimensions requested', () => {
      const fit = calculateImageFit({
        columns: 100,
        rows: 50,
        pixelWidth: 1000,
        pixelHeight: 800,
      });
      expect(fit.fitWidth).toBe(100);
      expect(fit.fitHeight).toBe(50);
    });

    test('clamps requested dimensions to terminal bounds (fit max cells <= terminal)', () => {
      const dims = { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 };

      const fit1 = calculateImageFit(dims, { width: 40, height: 10 });
      expect(fit1.fitWidth).toBe(40);
      expect(fit1.fitHeight).toBe(10);

      const fit2 = calculateImageFit(dims, { width: 120, height: 50 });
      expect(fit2.fitWidth).toBe(80);
      expect(fit2.fitHeight).toBe(24);
    });

    test('rejects invalid requested dimensions', () => {
      const dims = { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 };
      expect(() => calculateImageFit(dims, { width: 0 })).toThrow(ImagePresentationError);
      expect(() => calculateImageFit(dims, { height: -5 })).toThrow(ImagePresentationError);
    });
  });

  describe('buildIcatArgs', () => {
    test('produces exact expected argv using supplied geometry without --place or --clear', () => {
      const args = buildIcatArgs({
        dimensions: { columns: 120, rows: 40, pixelWidth: 1920, pixelHeight: 1080 },
        imagePath: '/path/to/test image.png',
      });

      expect(args).toEqual([
        'icat',
        '--stdin=no',
        '--use-window-size=120,40,1920,1080',
        '--fit=both',
        '--transfer-mode=stream',
        '--loop=0',
        '/path/to/test image.png',
      ]);

      // Never contains --place, --clear, or --clear-all
      expect(args.some((a) => a.startsWith('--place'))).toBe(false);
      expect(args.includes('--clear')).toBe(false);
      expect(args.includes('--clear-all')).toBe(false);
    });

    test('handles paths with spaces, Unicode and leading dashes safely as argv items', () => {
      const paths = ['/tmp/path with spaces/image.png', '/tmp/🖼️_image.png', '-leading-dash.png'];
      for (const p of paths) {
        const args = buildIcatArgs({
          dimensions: { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 },
          imagePath: p,
        });
        expect(args[args.length - 1]).toBe(p);
      }
    });
  });

  describe('captureIcatGraphics with fake executable', () => {
    const fakeScriptPath = path.join(testDir, 'fake-kitten.sh');

    test('captures graphics output and exact argv from fake kitten', async () => {
      const argvRecordPath = path.join(testDir, 'argv-record.json');
      const scriptContent = `#!/bin/sh
echo "$@" > "${argvRecordPath}"
printf '\\033_Gf=100,a=T,m=0;AAAA\\033\\134\\012'
exit 0
`;
      writeFileSync(fakeScriptPath, scriptContent);
      chmodSync(fakeScriptPath, 0o755);

      const dims = { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 };
      const args = buildIcatArgs({
        dimensions: dims,
        imagePath: '/test/image.png',
      });

      const output = await captureIcatGraphics({
        kittenBinary: fakeScriptPath,
        args,
      });

      expect(output.toString()).toBe('\x1b_Gf=100,a=T,m=0;AAAA\x1b\\\n');

      const recorded = require('node:fs').readFileSync(argvRecordPath, 'utf8').trim();
      expect(recorded).toBe(args.join(' '));
    });

    test('guards against timeout <= 0 or NaN', async () => {
      await expect(
        captureIcatGraphics({
          kittenBinary: fakeScriptPath,
          args: ['icat'],
          timeoutMs: 0,
        }),
      ).rejects.toThrow(ImagePresentationError);

      await expect(
        captureIcatGraphics({
          kittenBinary: fakeScriptPath,
          args: ['icat'],
          timeoutMs: Number.NaN,
        }),
      ).rejects.toThrow(ImagePresentationError);
    });

    test('guards against maxBuffer <= 0 or NaN', async () => {
      await expect(
        captureIcatGraphics({
          kittenBinary: fakeScriptPath,
          args: ['icat'],
          maxBuffer: 0,
        }),
      ).rejects.toThrow(ImagePresentationError);

      await expect(
        captureIcatGraphics({
          kittenBinary: fakeScriptPath,
          args: ['icat'],
          maxBuffer: Number.NaN,
        }),
      ).rejects.toThrow(ImagePresentationError);
    });

    test('rejects on child failure with bounded stderr message', async () => {
      const failScript = path.join(testDir, 'fake-fail.sh');
      writeFileSync(failScript, '#!/bin/sh\necho "Simulated icat error" >&2\nexit 1\n');
      chmodSync(failScript, 0o755);

      try {
        await captureIcatGraphics({
          kittenBinary: failScript,
          args: ['icat', '--stdin=no'],
        });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(ImagePresentationError);
        expect((err as ImagePresentationError).code).toBe('ICAT_FAILED');
        expect((err as Error).message).toContain('Simulated icat error');
      }
    });

    test('rejects on empty output', async () => {
      const emptyScript = path.join(testDir, 'fake-empty.sh');
      writeFileSync(emptyScript, '#!/bin/sh\nexit 0\n');
      chmodSync(emptyScript, 0o755);

      try {
        await captureIcatGraphics({
          kittenBinary: emptyScript,
          args: ['icat'],
        });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(ImagePresentationError);
        expect((err as ImagePresentationError).code).toBe('EMPTY_OUTPUT');
      }
    });

    test('rejects on timeout', async () => {
      const slowScript = path.join(testDir, 'fake-slow.sh');
      writeFileSync(slowScript, '#!/bin/sh\nsleep 5\nexit 0\n');
      chmodSync(slowScript, 0o755);

      try {
        await captureIcatGraphics({
          kittenBinary: slowScript,
          args: ['icat'],
          timeoutMs: 100,
        });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(ImagePresentationError);
        expect((err as ImagePresentationError).code).toBe('TIMEOUT');
      }
    });

    test('rejects on maxBuffer exceeded', async () => {
      const bigScript = path.join(testDir, 'fake-big.sh');
      writeFileSync(bigScript, '#!/bin/sh\nhead -c 2048 /dev/zero\nexit 0\n');
      chmodSync(bigScript, 0o755);

      try {
        await captureIcatGraphics({
          kittenBinary: bigScript,
          args: ['icat'],
          maxBuffer: 512,
        });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(ImagePresentationError);
        expect((err as ImagePresentationError).code).toBe('MAX_BUFFER_EXCEEDED');
      }
    });

    test('rejects on abort signal', async () => {
      const slowScript = path.join(testDir, 'fake-slow-abort.sh');
      writeFileSync(slowScript, '#!/bin/sh\nsleep 5\nexit 0\n');
      chmodSync(slowScript, 0o755);

      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);

      try {
        await captureIcatGraphics({
          kittenBinary: slowScript,
          args: ['icat'],
          signal: controller.signal,
          timeoutMs: 5000,
        });
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(ImagePresentationError);
        expect((err as ImagePresentationError).code).toBe('ABORTED');
      }
    });
  });

  describe('writeToStreamWithBackpressure', () => {
    test('writes protocol bytes ending with newline successfully', async () => {
      const stream = new PassThrough();
      const chunks: Buffer[] = [];
      stream.on('data', (c) => chunks.push(c));

      const protocolOutput = Buffer.from('\x1b_Gf=100,a=T,m=0;AAAA\x1b\\\n');
      await writeToStreamWithBackpressure(stream, protocolOutput);
      expect(Buffer.concat(chunks).toString()).toBe('\x1b_Gf=100,a=T,m=0;AAAA\x1b\\\n');
    });

    test('handles backpressure and drain correctly without premature resolve', async () => {
      let drained = false;
      let callbackFired = false;
      const customStream = new Writable({
        highWaterMark: 10,
        write(_chunk, _encoding, callback) {
          setTimeout(() => {
            callbackFired = true;
            drained = true;
            callback();
          }, 30);
        },
      });

      const bigChunk = Buffer.alloc(100, 'A');
      await writeToStreamWithBackpressure(customStream, bigChunk);
      expect(callbackFired).toBe(true);
      expect(drained).toBe(true);
    });

    test('handles stream write error and preserves error listener', async () => {
      const errStream = new Writable({
        write(_chunk, _encoding, callback) {
          callback(new Error('EPIPE simulated'));
        },
      });
      errStream.on('error', () => {
        // Prevent uncaught stream error
      });

      try {
        await writeToStreamWithBackpressure(errStream, Buffer.from('fail'));
        expect(true).toBe(false);
      } catch (err) {
        expect(err).toBeInstanceOf(ImagePresentationError);
        expect((err as ImagePresentationError).code).toBe('WRITE_ERROR');
      }
    });
  });

  describe('presentInlineImage end-to-end with fake binary', () => {
    test('renders image to gated stdout preserving native protocol trailing newline', async () => {
      const pngPath = createDummyImage(
        'e2e.png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );

      const fakeBinary = path.join(testDir, 'fake-e2e.sh');
      writeFileSync(
        fakeBinary,
        "#!/bin/sh\nprintf '\\033_Gf=100,a=T,m=0;AAAA\\033\\134\\012'\nexit 0\n",
      );
      chmodSync(fakeBinary, 0o755);

      const written: Buffer[] = [];
      const mockStdout = new PassThrough() as NodeJS.WritableStream & { isTTY?: boolean };
      mockStdout.isTTY = true;
      mockStdout.on('data', (c) => written.push(c));

      const result = await presentInlineImage({
        imagePath: pngPath,
        dimensions: { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 },
        ownedTerminal: true,
        width: 40,
        height: 10,
        stdout: mockStdout,
        env: { KITTY_WINDOW_ID: '123' },
        kittenBinary: fakeBinary,
      });

      expect(result.displayed).toBe(true);
      expect(result.format).toBe('png');
      expect(result.fitWidth).toBe(40);
      expect(result.fitHeight).toBe(10);
      expect(result.graphicsByteLength).toBe(24);

      const outputString = Buffer.concat(written).toString();
      expect(outputString).toBe('\x1b_Gf=100,a=T,m=0;AAAA\x1b\\\n');
      // No manual absolute row reservation sequence
      expect(outputString.includes('\x1b[')).toBe(false);
      expect(outputString.includes('\x1b[11;1H')).toBe(false);
    });

    test('gates stdout: writes zero bytes when eligibility check fails', async () => {
      const pngPath = createDummyImage(
        'e2e-fail.png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );

      const written: Buffer[] = [];
      const mockStdout = new PassThrough() as NodeJS.WritableStream & { isTTY?: boolean };
      mockStdout.isTTY = true;
      mockStdout.on('data', (c) => written.push(c));

      // Non-owned terminal
      await expect(
        presentInlineImage({
          imagePath: pngPath,
          dimensions: { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 },
          ownedTerminal: false,
          stdout: mockStdout,
          env: { KITTY_WINDOW_ID: '123' },
        }),
      ).rejects.toThrow(ImagePresentationError);

      expect(written.length).toBe(0);

      // Multiplexer detected
      await expect(
        presentInlineImage({
          imagePath: pngPath,
          dimensions: { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 },
          ownedTerminal: true,
          stdout: mockStdout,
          env: { KITTY_WINDOW_ID: '123', TMUX: '1' },
        }),
      ).rejects.toThrow(ImagePresentationError);

      expect(written.length).toBe(0);
    });

    test('gates stdout: writes zero bytes when image file validation fails', async () => {
      const written: Buffer[] = [];
      const mockStdout = new PassThrough() as NodeJS.WritableStream & { isTTY?: boolean };
      mockStdout.isTTY = true;
      mockStdout.on('data', (c) => written.push(c));

      await expect(
        presentInlineImage({
          imagePath: '/non/existent/image.png',
          dimensions: { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 },
          ownedTerminal: true,
          stdout: mockStdout,
          env: { KITTY_WINDOW_ID: '123' },
        }),
      ).rejects.toThrow(ImagePresentationError);

      expect(written.length).toBe(0);
    });

    test('does not import electron or start graphics devices', async () => {
      const imagesSrc = require('node:fs').readFileSync(path.join(__dirname, 'images.ts'), 'utf8');
      expect(imagesSrc.includes("from 'electron'")).toBe(false);
      expect(imagesSrc.includes("require('electron')")).toBe(false);
      expect(imagesSrc.includes('BrowserWindow')).toBe(false);
    });
  });
});

test('requested inline cell bounds preserve physical cell size for icat scaling', () => {
  const args = buildIcatArgs({
    dimensions: { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 },
    imagePath: '/image.png',
    width: 40,
    height: 10,
  });
  expect(args).toContain('--use-window-size=40,10,400,200');
  expect(args).toContain('--fit=both');
  expect(args.some((arg) => arg.startsWith('--place'))).toBe(false);
});

test('completed inline writes do not accumulate stream error listeners', async () => {
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  const before = stream.listenerCount('error');
  await writeToStreamWithBackpressure(stream, Buffer.from('one'));
  await writeToStreamWithBackpressure(stream, Buffer.from('two'));
  expect(stream.listenerCount('error')).toBe(before);
});

describe('same-pane side-by-side presentation', () => {
  const {
    wrapText,
    getStringWidth,
    getGraphemeWidth,
    sanitizeTerminalText,
  } = require('./textMetrics');
  const { calculateSideBySidePartition, presentSideBySideImage } = require('./images');

  describe('wrapText and Unicode width handling', () => {
    test('wraps text cleanly at word boundaries', () => {
      expect(getGraphemeWidth('A')).toBe(1);
      const text = 'The quick brown fox jumps over the lazy dog';
      const lines = wrapText(text, 15);
      expect(lines).toEqual(['The quick brown', 'fox jumps over', 'the lazy dog']);
      for (const line of lines) {
        expect(getStringWidth(line)).toBeLessThanOrEqual(15);
      }
    });

    test('splits words longer than maxWidth', () => {
      const lines = wrapText('supercalifragilistic', 5);
      expect(lines).toEqual(['super', 'calif', 'ragil', 'istic']);
      for (const line of lines) {
        expect(getStringWidth(line)).toBeLessThanOrEqual(5);
      }
    });

    test('preserves explicit paragraphs and blank lines', () => {
      const text = 'First line\n\nSecond line after blank';
      const lines = wrapText(text, 20);
      expect(lines).toEqual(['First line', '', 'Second line after', 'blank']);
    });

    test('handles empty or zero width gracefully', () => {
      expect(wrapText('', 10)).toEqual([]);
      expect(wrapText('hello', 0)).toEqual(['']);
    });

    test('accurately calculates cell width and wraps CJK characters', () => {
      expect(getStringWidth('日本語')).toBe(6);
      expect(getStringWidth('中文测试')).toBe(8);
      expect(getStringWidth('한국어')).toBe(6);

      const cjkText = '日本語テストです'; // 8 CJK chars = 16 cells
      const lines = wrapText(cjkText, 6);
      expect(lines).toEqual(['日本語', 'テスト', 'です']);
      for (const line of lines) {
        expect(getStringWidth(line)).toBeLessThanOrEqual(6);
      }
    });

    test('accurately calculates width and preserves emoji graphemes', () => {
      expect(getStringWidth('🐱')).toBe(2);
      expect(getStringWidth('👨‍👩‍👧‍👦')).toBe(2); // Family emoji grapheme cluster = 2 cells

      const emojiText = '🐱 🐶 🐰 🦊';
      const lines = wrapText(emojiText, 5);
      expect(lines).toEqual(['🐱 🐶', '🐰 🦊']);
      for (const line of lines) {
        expect(getStringWidth(line)).toBeLessThanOrEqual(5);
      }
    });

    test('handles combining characters and zero-width characters', () => {
      expect(getStringWidth('é')).toBe(1); // e with acute accent
      expect(getStringWidth('test​zero')).toBe(8); // zero-width space
    });

    test('sanitizes C0 and C1 control characters and ANSI sequences', () => {
      const dirty = 'Hello\x1b[31mRed\x1b[0m\x00\x07World\u0085';
      const sanitized = sanitizeTerminalText(dirty);
      expect(sanitized).toBe('HelloRedWorld');
      expect(wrapText('Hello\x1b[31mRed\x1b[0m', 20)).toEqual(['HelloRed']);
    });
  });

  describe('calculateSideBySidePartition and option validation', () => {
    const dims = { columns: 100, rows: 40, pixelWidth: 1000, pixelHeight: 800 };

    test('computes default 50/50 partition with gutter for text-left', () => {
      const part = calculateSideBySidePartition({
        dimensions: dims,
        text: 'Hello world',
        layout: 'text-left',
      });
      // 100 - 2 (gutter) = 98 available => 49 text, 49 media
      expect(part.textColumns).toBe(49);
      expect(part.mediaColumns).toBe(49);
      expect(part.gutterColumns).toBe(2);
      expect(part.textLeft).toBe(0);
      expect(part.imageLeft).toBe(51); // 49 + 2
      expect(part.wrappedText).toEqual(['Hello world']);
      expect(part.mediaRows).toBe(24); // 49 / 2
      expect(part.totalRows).toBe(24);
      expect(part.layout).toBe('text-left');
    });

    test('computes media-left partition placing image at 0', () => {
      const part = calculateSideBySidePartition({
        dimensions: dims,
        text: 'Line 1\nLine 2',
        layout: 'media-left',
        columns: { text: 40, media: 40 },
      });
      expect(part.imageLeft).toBe(0);
      expect(part.mediaColumns).toBe(40);
      expect(part.textLeft).toBe(42); // 40 + 2 gutter
      expect(part.textColumns).toBe(40);
      expect(part.layout).toBe('media-left');
    });

    test('scales down oversized custom columns to fit terminal width', () => {
      const part = calculateSideBySidePartition({
        dimensions: { columns: 50, rows: 30, pixelWidth: 500, pixelHeight: 600 },
        text: 'Notes',
        columns: { text: 40, media: 40 }, // 40 + 40 + 2 = 82 > 50
      });
      expect(part.textColumns + part.mediaColumns + part.gutterColumns).toBeLessThanOrEqual(50);
      expect(part.textColumns).toBeGreaterThanOrEqual(5);
      expect(part.mediaColumns).toBeGreaterThanOrEqual(5);
    });

    test('refuses terminal dimensions that are too narrow (< 10 columns)', () => {
      expect(() =>
        calculateSideBySidePartition({
          dimensions: { columns: 9, rows: 20, pixelWidth: 90, pixelHeight: 200 },
          text: 'Hello',
        }),
      ).toThrow(ImagePresentationError);

      try {
        calculateSideBySidePartition({
          dimensions: { columns: 9, rows: 20, pixelWidth: 90, pixelHeight: 200 },
          text: 'Hello',
        });
      } catch (err: any) {
        expect(err.code).toBe('TERMINAL_TOO_NARROW');
      }
    });

    test('validates invalid options at helper boundary', () => {
      // Non-string text
      expect(() =>
        calculateSideBySidePartition({
          dimensions: dims,
          text: 123 as any,
        }),
      ).toThrow(ImagePresentationError);

      // Invalid layout
      expect(() =>
        calculateSideBySidePartition({
          dimensions: dims,
          text: 'valid',
          layout: 'center' as any,
        }),
      ).toThrow(ImagePresentationError);

      // Invalid columns
      expect(() =>
        calculateSideBySidePartition({
          dimensions: dims,
          text: 'valid',
          columns: { text: -5, media: 10 },
        }),
      ).toThrow(ImagePresentationError);

      // Invalid height
      expect(() =>
        calculateSideBySidePartition({
          dimensions: dims,
          text: 'valid',
          requestedHeight: 0,
        }),
      ).toThrow(ImagePresentationError);
    });

    test('bounds height and handles text overflow safely', () => {
      const longText = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8';
      const part = calculateSideBySidePartition({
        dimensions: dims,
        text: longText,
        requestedHeight: 4,
      });

      expect(part.totalRows).toBe(4);
      expect(part.wrappedText.length).toBe(4);
      // Last line receives ellipsis indicator
      expect(part.wrappedText[3]).toContain('…');
      expect(getStringWidth(part.wrappedText[3])).toBeLessThanOrEqual(part.textColumns);
    });
  });

  describe('buildIcatArgs with unicodePlaceholder', () => {
    test('formats unicode placeholder args and never contains --place', () => {
      const args = buildIcatArgs({
        dimensions: { columns: 100, rows: 40, pixelWidth: 1000, pixelHeight: 800 },
        imagePath: '/test/image.png',
        width: 45,
        height: 20,
        unicodePlaceholder: true,
        align: 'left',
        scaleUp: true,
      });
      expect(args).toContain('--unicode-placeholder=yes');
      expect(args).toContain('--align=left');
      expect(args).toContain('--scale-up=yes');
      expect(args).toContain('--use-window-size=45,20,450,400');
      expect(args).toContain('--transfer-mode=stream');
      expect(args).toContain('--stdin=no');
      expect(args.some((a) => a.startsWith('--place'))).toBe(false);
      expect(args).toContain('/test/image.png');
    });
  });

  describe('presentSideBySideImage', () => {
    test('renders side-by-side stream with unicode placeholder pipeline without cursor jumps', async () => {
      const validPng = createDummyImage(
        'side.png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      // Mock kitten icat output containing graphics command + colored placeholder rows
      const fakeKittenScript = path.join(testDir, 'fake-kitten-side.sh');
      writeFileSync(
        fakeKittenScript,
        '#!/bin/sh\nprintf "%s" "\x1b_Ga=T,q=2,f=100,U=1,s=100,v=75,c=10,r=3,i=42;AAAA\x1b\\\x1b[38:2:12:34:56m[IMG-ROW-0]\n\r[IMG-ROW-1]\n\r[IMG-ROW-2]\x1b[39m\n"\n',
      );
      chmodSync(fakeKittenScript, 0o755);

      const writtenChunks: Buffer[] = [];
      const mockStdout = new Writable({
        write(chunk, _encoding, callback) {
          writtenChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          callback();
        },
      });
      (mockStdout as any).isTTY = true;

      const result = await presentSideBySideImage({
        imagePath: validPng,
        text: 'Header text\nDescription line\nExtra details',
        dimensions: { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 },
        ownedTerminal: true,
        kittenBinary: fakeKittenScript,
        stdout: mockStdout,
        env: { PATH: process.env.PATH, KITTY_WINDOW_ID: '42' },
        layout: 'text-left',
        columns: { text: 30, media: 30 },
        height: 3,
      });

      expect(result.displayed).toBe(true);
      expect(result.format).toBe('png');
      expect(result.textColumns).toBe(30);
      expect(result.mediaColumns).toBe(30);
      expect(result.totalRows).toBe(3);

      const fullOutput = Buffer.concat(writtenChunks).toString('utf8');

      // 1. Upload graphics command is present with U=1
      expect(fullOutput).toContain('\x1b_Ga=T,q=2,f=100,U=1');

      // 2. NO absolute positioning sequences (no \x1b[...H, no \x1b[...f, no \x1b[...G, no --place)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequence check
      expect(fullOutput).not.toMatch(/\x1b\[\d+;\d+[Hf]/);
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequence check
      expect(fullOutput).not.toMatch(/\x1b\[\d+G/);
      expect(fullOutput).not.toContain('--place');

      // 3. Lines contain text on left and colored placeholders on right
      expect(fullOutput).toContain('Header text');
      expect(fullOutput).toContain('[IMG-ROW-0]');
      expect(fullOutput).toContain('\x1b[38:2:12:34:56m');
      expect(fullOutput).toContain('\x1b[39m');

      // 4. Lines end with CRLF reserving natural rows
      const lines = fullOutput.split('\r\n');
      expect(lines.length).toBeGreaterThanOrEqual(3);
    });

    test('prevents nonzero prior cursor regression (preserves prior shell output intact)', async () => {
      const validPng = createDummyImage(
        'side-prior.png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      const fakeKittenScript = path.join(testDir, 'fake-kitten-prior.sh');
      writeFileSync(
        fakeKittenScript,
        '#!/bin/sh\nprintf "%s" "\x1b_Ga=T,U=1;BBBB\x1b\\\x1b[38:2:1:2:3m[P0]\n\r[P1]\x1b[39m\n"\n',
      );
      chmodSync(fakeKittenScript, 0o755);

      const writtenChunks: Buffer[] = [];
      const mockStdout = new Writable({
        write(chunk, _encoding, callback) {
          writtenChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          callback();
        },
      });
      (mockStdout as any).isTTY = true;

      // Pre-populate stdout stream with existing shell prompt & prior command output
      const priorContent = 'user@host:~$ previous_command\r\nline 1 of previous output\r\n';
      mockStdout.write(priorContent);

      await presentSideBySideImage({
        imagePath: validPng,
        text: 'New presentation line',
        dimensions: { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 },
        ownedTerminal: true,
        kittenBinary: fakeKittenScript,
        stdout: mockStdout,
        env: { PATH: process.env.PATH, KITTY_WINDOW_ID: '42' },
        layout: 'text-left',
        height: 2,
      });

      const fullOutput = Buffer.concat(writtenChunks).toString('utf8');

      // Prior shell content must be 100% intact at the start
      expect(fullOutput.startsWith(priorContent)).toBe(true);

      // No cursor jumping back to line 0 or overwriting prior text
      expect(fullOutput).not.toContain('\x1b[0;0H');
      expect(fullOutput).not.toContain('\x1b[1;1H');
      expect(fullOutput).not.toContain('\x1b[H');
      expect(fullOutput).not.toContain('\x1b[2J'); // No clear screen
    });

    test('supports media-left layout with natural line reservation (no horizontal cursor jumps)', async () => {
      const validPng = createDummyImage(
        'side-left.png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      const fakeKittenScript = path.join(testDir, 'fake-kitten-media-left.sh');
      writeFileSync(
        fakeKittenScript,
        '#!/bin/sh\nprintf "%s" "\x1b_Ga=T,U=1;CCCC\x1b\\\x1b[38:2:9:8:7m[MEDIA-ROW-0]\x1b[39m\n"\n',
      );
      chmodSync(fakeKittenScript, 0o755);

      const writtenChunks: Buffer[] = [];
      const mockStdout = new Writable({
        write(chunk, _encoding, callback) {
          writtenChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          callback();
        },
      });
      (mockStdout as any).isTTY = true;

      const result = await presentSideBySideImage({
        imagePath: validPng,
        text: 'Right column text',
        dimensions: { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 },
        ownedTerminal: true,
        kittenBinary: fakeKittenScript,
        stdout: mockStdout,
        env: { PATH: process.env.PATH, KITTY_WINDOW_ID: '42' },
        layout: 'media-left',
        columns: { text: 30, media: 30 },
        height: 2,
      });

      expect(result.layout).toBe('media-left');
      const fullOutput = Buffer.concat(writtenChunks).toString('utf8');

      // In media-left, media is printed first, then gutter, then text on same line
      expect(fullOutput).toContain('[MEDIA-ROW-0]');
      expect(fullOutput).toContain('Right column text');
      // No \x1b[...G cursor horizontal positioning
      // biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequence check
      expect(fullOutput).not.toMatch(/\x1b\[\d+G/);
    });

    test('validates and rejects narrow or invalid arguments in presentSideBySideImage', async () => {
      const validPng = createDummyImage(
        'side-val.png',
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      );
      const mockStdout = new Writable({
        write(_c, _e, cb) {
          cb();
        },
      });
      (mockStdout as any).isTTY = true;

      // Terminal too narrow
      await expect(
        presentSideBySideImage({
          imagePath: validPng,
          text: 'test',
          dimensions: { columns: 8, rows: 20, pixelWidth: 80, pixelHeight: 200 },
          ownedTerminal: true,
          stdout: mockStdout,
          env: { KITTY_WINDOW_ID: '42' },
        }),
      ).rejects.toThrow(ImagePresentationError);

      // Invalid layout
      await expect(
        presentSideBySideImage({
          imagePath: validPng,
          text: 'test',
          dimensions: { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 },
          ownedTerminal: true,
          stdout: mockStdout,
          env: { KITTY_WINDOW_ID: '42' },
          layout: 'invalid' as any,
        }),
      ).rejects.toThrow(ImagePresentationError);
    });

    test('inspects actual kitten output using fixture captured pipe when kitten is installed', async () => {
      const { resolveKittenBinary } = require('./capabilities');
      const resolved = resolveKittenBinary(process.env);
      if (!resolved.binaryPath) {
        return; // Skip if kitten not installed on host
      }

      // Use actual PNG fixture from repo: src/tty/finch.png
      const fixturePath = path.resolve(__dirname, '../tty/finch.png');
      if (!require('node:fs').existsSync(fixturePath)) {
        return;
      }

      const writtenChunks: Buffer[] = [];
      const mockStdout = new Writable({
        write(chunk, _encoding, callback) {
          writtenChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          callback();
        },
      });
      (mockStdout as any).isTTY = true;

      const result = await presentSideBySideImage({
        imagePath: fixturePath,
        text: 'Title: Finch Preview\nDescription: Sample test image\nLine 3 notes',
        dimensions: { columns: 80, rows: 24, pixelWidth: 800, pixelHeight: 480 },
        ownedTerminal: true,
        stdout: mockStdout,
        env: { KITTY_WINDOW_ID: '42' },
        layout: 'text-left',
        columns: { text: 30, media: 30 },
        height: 6,
      });

      expect(result.displayed).toBe(true);
      expect(result.format).toBe('png');
      expect(result.textColumns).toBe(30);
      expect(result.mediaColumns).toBe(30);
      expect(result.totalRows).toBe(6);

      const captured = Buffer.concat(writtenChunks).toString('utf8');

      // Verify Kitty graphics protocol upload contains U=1 (unicode placeholder)
      expect(captured).toContain('\x1b_G');
      expect(captured).toContain('U=1');

      // Verify Kitty Unicode placeholder characters (\u{10EEEE}) are captured
      expect(captured.includes('\u{10EEEE}')).toBe(true);

      // Verify text lines are combined with placeholders on the same lines
      expect(captured).toContain('Title: Finch Preview');
      expect(captured).toContain('Description: Sample test image');

      // Verify lines end with CRLF
      const lines = captured.split('\r\n');
      expect(lines.length).toBeGreaterThanOrEqual(6);
    });
  });
});
