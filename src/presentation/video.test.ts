import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findBinary } from '../adb/adbControl';
import {
  MAX_INPUT_FILE_BYTES,
  VIDEO_FPS,
  isValidVideoId,
  parsePngDimensions,
  prepareVideo,
  pruneVideoCache,
} from './video';

const resolvedFfmpeg = findBinary('ffmpeg');
const resolvedFfprobe = findBinary('ffprobe');
const hasFfmpeg = fs.existsSync(resolvedFfmpeg) && fs.existsSync(resolvedFfprobe);

// 2x2 PNG fixture
const VALID_2X2_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

let tempDir: string;
let cacheRoot: string;

function hashBuffer(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('video preview decoder', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-video-test-'));
    cacheRoot = path.join(tempDir, 'video-previews');
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  describe('utility validation', () => {
    test('isValidVideoId matches regex ^vid-[a-f0-9]{24}$', () => {
      const valid = `vid-${'a'.repeat(24)}`;
      expect(isValidVideoId(valid)).toBe(true);
      expect(isValidVideoId(`vid-${'f0123456789abcdef0123456'}`)).toBe(true);
      expect(isValidVideoId('vid-xyz')).toBe(false);
      expect(isValidVideoId(`vid-${'a'.repeat(23)}`)).toBe(false);
      expect(isValidVideoId(`vid-${'a'.repeat(25)}`)).toBe(false);
      expect(isValidVideoId('../../vid-1234567890abcdef123456')).toBe(false);
      expect(isValidVideoId(null)).toBe(false);
      expect(isValidVideoId('')).toBe(false);
    });

    test('parsePngDimensions parses width and height from valid PNG', () => {
      const dims = parsePngDimensions(VALID_2X2_PNG);
      expect(dims.width).toBe(2);
      expect(dims.height).toBe(2);
    });

    test('parsePngDimensions rejects invalid buffers', () => {
      expect(() => parsePngDimensions(Buffer.alloc(10))).toThrow('Buffer too small');
      expect(() => parsePngDimensions(Buffer.alloc(30))).toThrow('Invalid PNG signature');
      const fakePng = Buffer.alloc(30);
      fakePng[0] = 0x89;
      fakePng[1] = 0x50;
      fakePng[2] = 0x4e;
      fakePng[3] = 0x47;
      fakePng[4] = 0x0d;
      fakePng[5] = 0x0a;
      fakePng[6] = 0x1a;
      fakePng[7] = 0x0a;
      expect(() => parsePngDimensions(fakePng)).toThrow('PNG missing initial IHDR chunk');
    });
  });

  describe('input rejection before execution', () => {
    test('rejects empty path or non-string', async () => {
      await expect(prepareVideo('')).rejects.toThrow('Video path is required');
    });

    test('rejects remote URLs with protocol scheme', async () => {
      await expect(prepareVideo('https://example.com/demo.mp4')).rejects.toThrow(
        'Remote video URLs are not allowed',
      );
      await expect(prepareVideo('file://test.mp4')).rejects.toThrow(
        'Remote video URLs are not allowed',
      );
    });

    test('rejects unsupported extensions', async () => {
      const txtFile = path.join(tempDir, 'sample.txt');
      fs.writeFileSync(txtFile, 'hello');
      await expect(prepareVideo(txtFile)).rejects.toThrow('Unsupported video format');
    });

    test('rejects non-existent file', async () => {
      await expect(prepareVideo(path.join(tempDir, 'does-not-exist.mp4'))).rejects.toThrow(
        'Video file does not exist',
      );
    });

    test('rejects directories', async () => {
      const dirAsMp4 = path.join(tempDir, 'folder.mp4');
      fs.mkdirSync(dirAsMp4);
      await expect(prepareVideo(dirAsMp4)).rejects.toThrow('Target is not a regular file');
    });

    test('rejects empty 0-byte file', async () => {
      const emptyMp4 = path.join(tempDir, 'empty.mp4');
      fs.writeFileSync(emptyMp4, Buffer.alloc(0));
      await expect(prepareVideo(emptyMp4)).rejects.toThrow('Video file is empty');
    });

    test('rejects file exceeding 100 MiB input limit', async () => {
      const largeMp4 = path.join(tempDir, 'large.mp4');
      const fd = fs.openSync(largeMp4, 'w');
      fs.ftruncateSync(fd, MAX_INPUT_FILE_BYTES + 1024);
      fs.closeSync(fd);
      await expect(prepareVideo(largeMp4)).rejects.toThrow('exceeds 100 MiB limit');
    });
  });

  describe('real ffmpeg / ffprobe fixture tests', () => {
    test('decodes known-duration clip and asserts frame differences, dimensions, and permissions', async () => {
      if (!hasFfmpeg) return;

      const clipPath = path.join(tempDir, 'known.mp4');
      const genProc = Bun.spawnSync([
        resolvedFfmpeg,
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=0.3:size=320x240:rate=10',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        clipPath,
      ]);
      expect(genProc.exitCode).toBe(0);

      const preview = await prepareVideo(clipPath, {
        cacheRoot,
        ffmpegBin: resolvedFfmpeg,
        ffprobeBin: resolvedFfprobe,
      });

      expect(isValidVideoId(preview.id)).toBe(true);
      expect(preview.source).toBe(fs.realpathSync(clipPath));
      expect(preview.dir).toBe(path.join(cacheRoot, preview.id));
      expect(preview.poster).toBe(path.join(preview.dir, 'f00001.png'));
      expect(preview.count).toBe(3);
      expect(preview.fps).toBe(VIDEO_FPS);
      expect(preview.width).toBe(320);
      expect(preview.height).toBe(240);
      expect(preview.duration).toBeGreaterThan(0.25);
      expect(preview.duration).toBeLessThanOrEqual(0.35);

      // Permissions check
      const dirStat = fs.statSync(preview.dir);
      expect(dirStat.mode & 0o777).toBe(0o700);

      const manifestPath = path.join(preview.dir, 'manifest.json');
      expect(fs.existsSync(manifestPath)).toBe(true);
      const manifestStat = fs.statSync(manifestPath);
      expect(manifestStat.mode & 0o777).toBe(0o600);

      // Verify frame differences
      const frame1 = fs.readFileSync(path.join(preview.dir, 'f00001.png'));
      const frame2 = fs.readFileSync(path.join(preview.dir, 'f00002.png'));
      const frame3 = fs.readFileSync(path.join(preview.dir, 'f00003.png'));

      const hash1 = hashBuffer(frame1);
      const hash2 = hashBuffer(frame2);
      const hash3 = hashBuffer(frame3);

      expect(hash1).not.toBe(hash2);
      expect(hash2).not.toBe(hash3);

      // Verify poster dimensions match
      const posterDims = parsePngDimensions(frame1);
      expect(posterDims.width).toBe(320);
      expect(posterDims.height).toBe(240);
    });

    test('decodes unknown-duration WebM clip and scales to longest axis 960 without upscaling', async () => {
      if (!hasFfmpeg) return;

      const webmPath = path.join(tempDir, 'unknown.webm');
      const genProc = Bun.spawnSync([
        'sh',
        '-c',
        `${resolvedFfmpeg} -y -f lavfi -i testsrc=duration=0.3:size=1920x1080:rate=10 -c:v vp8 -f webm pipe:1 > "${webmPath}"`,
      ]);
      expect(genProc.exitCode).toBe(0);

      const preview = await prepareVideo(webmPath, {
        cacheRoot,
        ffmpegBin: resolvedFfmpeg,
        ffprobeBin: resolvedFfprobe,
      });

      expect(preview.count).toBe(3);
      expect(preview.fps).toBe(10);
      // Scaled down: 1920x1080 -> 960x540
      expect(preview.width).toBe(960);
      expect(preview.height).toBe(540);
      expect(preview.duration).toBeCloseTo(0.3, 1);

      // Frame hashes differ
      const frame1 = fs.readFileSync(path.join(preview.dir, 'f00001.png'));
      const frame2 = fs.readFileSync(path.join(preview.dir, 'f00002.png'));
      expect(hashBuffer(frame1)).not.toBe(hashBuffer(frame2));
    });

    test('portrait video scales longest axis to 960 maintaining aspect ratio', async () => {
      if (!hasFfmpeg) return;

      const portraitPath = path.join(tempDir, 'portrait.mp4');
      const genProc = Bun.spawnSync([
        resolvedFfmpeg,
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=0.2:size=1080x1920:rate=10',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        portraitPath,
      ]);
      expect(genProc.exitCode).toBe(0);

      const preview = await prepareVideo(portraitPath, {
        cacheRoot,
        ffmpegBin: resolvedFfmpeg,
        ffprobeBin: resolvedFfprobe,
      });

      expect(preview.height).toBe(960);
      expect(preview.width).toBe(540);
    });

    test('rejects video exceeding 60 seconds duration during probe', async () => {
      if (!hasFfmpeg) return;

      // Create a fake probe script that returns duration > 60
      const fakeProbeScript = path.join(tempDir, 'fake-ffprobe.sh');
      fs.writeFileSync(
        fakeProbeScript,
        '#!/bin/sh\necho \'{"streams":[{"width":640,"height":480,"duration":"65.5"}],"format":{"duration":"65.5"}}\'\n',
      );
      fs.chmodSync(fakeProbeScript, 0o755);

      const clipPath = path.join(tempDir, 'test_dummy.mp4');
      fs.writeFileSync(clipPath, 'fake-mp4-data');

      await expect(
        prepareVideo(clipPath, {
          cacheRoot,
          ffprobeBin: fakeProbeScript,
          ffmpegBin: resolvedFfmpeg,
        }),
      ).rejects.toThrow('Video duration exceeds 60 seconds limit');
    });

    test('enforces maxDecodedBytes limit during ffmpeg and terminates process', async () => {
      if (!hasFfmpeg) return;

      const clipPath = path.join(tempDir, 'overflow.mp4');
      const genProc = Bun.spawnSync([
        resolvedFfmpeg,
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=0.4:size=320x240:rate=10',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        clipPath,
      ]);
      expect(genProc.exitCode).toBe(0);

      // Set maxDecodedBytes very low (100 bytes)
      await expect(
        prepareVideo(clipPath, {
          cacheRoot,
          maxDecodedBytes: 100,
          ffmpegBin: resolvedFfmpeg,
          ffprobeBin: resolvedFfprobe,
        }),
      ).rejects.toThrow('Decoded frames exceeded limit');

      // Verify no leftover pending directories
      const remaining = fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : [];
      expect(remaining.filter((f) => f.startsWith('.pending-')).length).toBe(0);
    });

    test('terminates and cleans up on timeout', async () => {
      if (!hasFfmpeg) return;

      const clipPath = path.join(tempDir, 'timeout.mp4');
      const genProc = Bun.spawnSync([
        resolvedFfmpeg,
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc=duration=0.2:size=320x240:rate=10',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        clipPath,
      ]);
      expect(genProc.exitCode).toBe(0);

      const slowScript = path.join(tempDir, 'slow-ffmpeg.sh');
      fs.writeFileSync(slowScript, '#!/bin/sh\nexec sleep 5\n');
      fs.chmodSync(slowScript, 0o755);

      await expect(
        prepareVideo(clipPath, {
          cacheRoot,
          timeoutMs: 100,
          ffmpegBin: slowScript,
          ffprobeBin: resolvedFfprobe,
        }),
      ).rejects.toThrow('Video decoding timed out');

      // Pending dir removed
      const remaining = fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : [];
      expect(remaining.filter((f) => f.startsWith('.pending-')).length).toBe(0);
    });
  });

  describe('global cache pruning', () => {
    test('prunes oldest completed directories when exceeding size limit and preserves active prep', () => {
      fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });

      function createMockCompleted(id: string, sizeBytes: number, createdAt: number) {
        const dir = path.join(cacheRoot, id);
        fs.mkdirSync(dir, { mode: 0o700 });
        const frame = path.join(dir, 'f00001.png');
        fs.writeFileSync(frame, Buffer.alloc(sizeBytes));
        const manifest = {
          id,
          source: '/fake/source.mp4',
          dir,
          poster: frame,
          width: 320,
          height: 240,
          count: 1,
          fps: 10,
          duration: 0.1,
          createdAt,
          marker: `![awrit:video](${frame})`,
        };
        fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest), {
          mode: 0o600,
        });
      }

      const id1 = `vid-${'1'.repeat(24)}`;
      const id2 = `vid-${'2'.repeat(24)}`;
      const id3 = `vid-${'3'.repeat(24)}`;

      createMockCompleted(id1, 1024 * 1024, 1000); // 1 MB, oldest
      createMockCompleted(id2, 1024 * 1024, 2000); // 1 MB, middle
      createMockCompleted(id3, 1024 * 1024, 3000); // 1 MB, newest

      // Add a pending dir (must NOT be pruned)
      const pendingDir = path.join(cacheRoot, `.pending-${id1}`);
      fs.mkdirSync(pendingDir, { mode: 0o700 });

      // Prune with a max budget of 2.5 MB, preserving id1
      // Total size is 3 MB -> id2 is older than id3, but id1 is preserved, so id2 should be pruned!
      pruneVideoCache(cacheRoot, id1, 2.5 * 1024 * 1024);

      expect(fs.existsSync(path.join(cacheRoot, id1))).toBe(true);
      expect(fs.existsSync(path.join(cacheRoot, id2))).toBe(false);
      expect(fs.existsSync(path.join(cacheRoot, id3))).toBe(true);
      expect(fs.existsSync(pendingDir)).toBe(true);
    });
  });
});
