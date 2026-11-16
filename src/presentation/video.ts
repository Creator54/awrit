import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findBinary } from '../adb/adbControl';
import { getAppDataPath } from '../paths';

export const VIDEO_ID_REGEX = /^vid-[a-f0-9]{24}$/;
export const ALLOWED_EXTENSIONS = new Set([
  '.mp4',
  '.mov',
  '.m4v',
  '.webm',
  '.mkv',
  '.avi',
  '.gif',
]);
export const MAX_INPUT_FILE_BYTES = 100 * 1024 * 1024; // 100 MiB
export const MAX_DECODED_CLIP_BYTES = 128 * 1024 * 1024; // 128 MiB
export const MAX_GLOBAL_CACHE_BYTES = 256 * 1024 * 1024; // 256 MiB
export const MAX_VIDEO_DURATION_SEC = 60;
export const MAX_VIDEO_FRAMES = 600;
export const VIDEO_FPS = 10;
export const PROTOCOL_WHITELIST = 'file,pipe';
export const FORMAT_WHITELIST = 'mov,matroska,webm,gif,avi';

export interface VideoPreview {
  id: string;
  source: string;
  dir: string;
  poster: string;
  width: number;
  height: number;
  count: number;
  fps: number;
  duration: number;
}

export interface VideoPrepareOptions {
  ffmpegBin?: string;
  ffprobeBin?: string;
  maxDecodedBytes?: number;
  maxGlobalCacheBytes?: number;
  timeoutMs?: number;
  cacheRoot?: string;
}

export function isValidVideoId(id: unknown): id is string {
  return typeof id === 'string' && VIDEO_ID_REGEX.test(id);
}

export function getVideoPreviewsDir(): string {
  const dir = path.join(getAppDataPath(), 'video-previews');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

export function parsePngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) {
    throw new Error('Buffer too small to be a valid PNG');
  }
  const isPng =
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a;
  if (!isPng) {
    throw new Error('Invalid PNG signature');
  }
  const isIhdr = buf[12] === 0x49 && buf[13] === 0x48 && buf[14] === 0x44 && buf[15] === 0x52;
  if (!isIhdr) {
    throw new Error('PNG missing initial IHDR chunk');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width === 0 || height === 0) {
    throw new Error('Invalid zero PNG dimensions');
  }
  return { width, height };
}

interface ProbeResult {
  width: number;
  height: number;
  duration?: number;
}

function probeVideo(
  probeBin: string,
  canonicalPath: string,
  timeoutMs = 10000,
): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const probeArgs = [
      '-v',
      'error',
      '-protocol_whitelist',
      PROTOCOL_WHITELIST,
      '-format_whitelist',
      FORMAT_WHITELIST,
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-select_streams',
      'v:0',
      canonicalPath,
    ];

    let proc: ChildProcess;
    try {
      proc = spawn(probeBin, probeArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(
        new Error(`Failed to spawn ffprobe: ${err instanceof Error ? err.message : String(err)}`),
      );
    }

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {}
      reject(new Error(`ffprobe timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ffprobe error: ${err.message}`));
    });

    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        const msg = stderr.trim() || `ffprobe exited with code ${code ?? signal}`;
        return reject(new Error(`Video probe failed: ${msg}`));
      }

      let probeData: {
        streams?: Array<{ width?: number; height?: number; duration?: string }>;
        format?: { duration?: string };
      };
      try {
        probeData = JSON.parse(stdout);
      } catch {
        return reject(new Error('Failed to parse ffprobe output as JSON'));
      }

      const streams = probeData.streams;
      if (!Array.isArray(streams) || streams.length === 0) {
        return reject(new Error('No video stream found in file'));
      }

      const vStream = streams[0];
      const rawWidth = vStream.width;
      const rawHeight = vStream.height;
      if (
        typeof rawWidth !== 'number' ||
        typeof rawHeight !== 'number' ||
        !Number.isInteger(rawWidth) ||
        !Number.isInteger(rawHeight) ||
        rawWidth <= 0 ||
        rawHeight <= 0 ||
        rawWidth > 8192 ||
        rawHeight > 8192
      ) {
        return reject(new Error(`Invalid video dimensions: ${rawWidth}x${rawHeight}`));
      }

      const rawDuration = vStream.duration ?? probeData.format?.duration;
      let duration: number | undefined;
      if (rawDuration !== undefined && rawDuration !== null && rawDuration !== 'N/A') {
        const parsedDur = Number(rawDuration);
        if (!Number.isFinite(parsedDur) || parsedDur <= 0) {
          return reject(new Error(`Invalid video duration: ${rawDuration}`));
        }
        if (parsedDur > MAX_VIDEO_DURATION_SEC) {
          return reject(
            new Error(
              `Video duration exceeds ${MAX_VIDEO_DURATION_SEC} seconds limit (${parsedDur.toFixed(2)}s)`,
            ),
          );
        }
        duration = parsedDur;
      }

      resolve({ width: rawWidth, height: rawHeight, duration });
    });
  });
}

function decodeFrames(
  ffmpegBin: string,
  canonicalPath: string,
  pendingDir: string,
  maxDecodedBytes: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const scaleFilter =
      "scale=w='min(960,iw)':h='min(960,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2";
    const ffmpegArgs = [
      '-v',
      'error',
      '-nostdin',
      '-protocol_whitelist',
      PROTOCOL_WHITELIST,
      '-format_whitelist',
      FORMAT_WHITELIST,
      '-i',
      canonicalPath,
      '-map',
      '0:v:0',
      '-an',
      '-threads',
      '1',
      '-vf',
      `fps=${VIDEO_FPS},${scaleFilter}`,
      '-frames:v',
      '601',
      path.join(pendingDir, 'f%05d.png'),
    ];

    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    let monitorInterval: NodeJS.Timeout | null = null;
    let proc: ChildProcess;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (monitorInterval) clearInterval(monitorInterval);
    };

    const killAndCleanup = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();

      try {
        proc.stderr?.destroy();
      } catch {}

      try {
        proc.kill('SIGTERM');
      } catch {}

      const forceKillTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {}
      }, 1000);

      proc.once('close', () => {
        clearTimeout(forceKillTimer);
        try {
          fs.rmSync(pendingDir, { recursive: true, force: true });
        } catch {}
        reject(err);
      });
    };

    try {
      proc = spawn(ffmpegBin, ffmpegArgs, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      settled = true;
      cleanup();
      try {
        fs.rmSync(pendingDir, { recursive: true, force: true });
      } catch {}
      return reject(
        new Error(`Failed to spawn ffmpeg: ${err instanceof Error ? err.message : String(err)}`),
      );
    }

    let stderr = '';
    proc.stderr?.on('data', (d) => {
      if (stderr.length < 16384) {
        stderr += d.toString();
      }
    });

    proc.on('error', (err) => {
      killAndCleanup(new Error(`ffmpeg error: ${err.message}`));
    });

    timer = setTimeout(() => {
      killAndCleanup(new Error(`Video decoding timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    monitorInterval = setInterval(() => {
      if (settled) return;
      try {
        if (fs.existsSync(pendingDir)) {
          const files = fs.readdirSync(pendingDir);
          let totalBytes = 0;
          for (const file of files) {
            const stat = fs.statSync(path.join(pendingDir, file));
            totalBytes += stat.size;
          }
          if (totalBytes > maxDecodedBytes) {
            killAndCleanup(new Error(`Decoded frames exceeded limit of ${maxDecodedBytes} bytes`));
          }
        }
      } catch {}
    }, 100);

    proc.on('close', (code, signal) => {
      cleanup();
      if (settled) return;
      settled = true;
      if (code !== 0) {
        try {
          fs.rmSync(pendingDir, { recursive: true, force: true });
        } catch {}
        const msg = stderr.trim() || `ffmpeg exited with code ${code ?? signal}`;
        return reject(new Error(`Video decoding failed: ${msg}`));
      }
      resolve();
    });
  });
}

export function pruneVideoCache(
  cacheRoot: string,
  preserveId?: string,
  maxGlobalCacheBytes = MAX_GLOBAL_CACHE_BYTES,
): void {
  if (!fs.existsSync(cacheRoot)) return;

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  } catch {
    return;
  }

  interface CompletedVidDir {
    id: string;
    dirPath: string;
    size: number;
    createdAt: number;
  }

  const validDirs: CompletedVidDir[] = [];
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;

  for (const entry of entries) {
    if (!entry.isDirectory() || !VIDEO_ID_REGEX.test(entry.name)) {
      continue;
    }

    const dirPath = path.join(cacheRoot, entry.name);
    try {
      const lstat = fs.lstatSync(dirPath);
      if (lstat.isSymbolicLink() || (currentUid !== undefined && lstat.uid !== currentUid)) {
        continue;
      }

      const files = fs.readdirSync(dirPath);
      if (!files.includes('manifest.json')) {
        continue;
      }

      let hasInvalidFile = false;
      let totalSize = 0;
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        const fileStat = fs.lstatSync(filePath);
        if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
          hasInvalidFile = true;
          break;
        }
        if (file !== 'manifest.json' && !/^f\d{5}\.png$/.test(file)) {
          hasInvalidFile = true;
          break;
        }
        totalSize += fileStat.size;
      }
      if (hasInvalidFile) continue;

      const manifestPath = path.join(dirPath, 'manifest.json');
      const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
      const manifest = JSON.parse(manifestRaw);
      if (
        !manifest ||
        typeof manifest !== 'object' ||
        manifest.id !== entry.name ||
        typeof manifest.count !== 'number' ||
        manifest.count <= 0 ||
        typeof manifest.marker !== 'string' ||
        !manifest.marker.includes(entry.name)
      ) {
        continue;
      }

      const createdAt =
        typeof manifest.createdAt === 'number' && Number.isFinite(manifest.createdAt)
          ? manifest.createdAt
          : lstat.mtimeMs;

      validDirs.push({
        id: entry.name,
        dirPath,
        size: totalSize,
        createdAt,
      });
    } catch {
      // Skip invalid or unreadable directories
    }
  }

  let totalCacheSize = validDirs.reduce((acc, d) => acc + d.size, 0);
  if (totalCacheSize <= maxGlobalCacheBytes) return;

  const prunable = validDirs
    .filter((d) => d.id !== preserveId)
    .sort((a, b) => a.createdAt - b.createdAt);

  for (const candidate of prunable) {
    if (totalCacheSize <= maxGlobalCacheBytes) break;
    try {
      fs.rmSync(candidate.dirPath, { recursive: true, force: true });
      totalCacheSize -= candidate.size;
    } catch {}
  }
}

export async function prepareVideo(
  rawPath: string,
  options?: VideoPrepareOptions,
): Promise<VideoPreview> {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error('Video path is required');
  }

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(rawPath) || rawPath.includes('://')) {
    throw new Error('Remote video URLs are not allowed');
  }

  const ext = path.extname(rawPath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    throw new Error(`Unsupported video format: ${ext}`);
  }

  if (!fs.existsSync(rawPath)) {
    throw new Error(`Video file does not exist: ${rawPath}`);
  }

  const canonicalPath = fs.realpathSync(rawPath);
  const stat = fs.statSync(canonicalPath);
  if (!stat.isFile()) {
    throw new Error(`Target is not a regular file: ${rawPath}`);
  }
  if (stat.size === 0) {
    throw new Error('Video file is empty');
  }
  if (stat.size > MAX_INPUT_FILE_BYTES) {
    throw new Error(`Video file exceeds 100 MiB limit (${stat.size} bytes)`);
  }

  const probeBin = options?.ffprobeBin ?? findBinary('ffprobe');
  if (!probeBin || !fs.existsSync(probeBin)) {
    throw new Error(`ffprobe binary not found: ${probeBin}`);
  }

  const probe = await probeVideo(probeBin, canonicalPath, options?.timeoutMs ?? 10000);

  const cacheRoot = options?.cacheRoot ?? getVideoPreviewsDir();
  if (!fs.existsSync(cacheRoot)) {
    fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  } else {
    try {
      fs.chmodSync(cacheRoot, 0o700);
    } catch {}
  }

  const id = 'vid-' + randomBytes(12).toString('hex');
  const pendingDir = path.join(cacheRoot, `.pending-${id}`);
  const completedDir = path.join(cacheRoot, id);

  fs.mkdirSync(pendingDir, { mode: 0o700 });

  const ffmpegBin = options?.ffmpegBin ?? findBinary('ffmpeg');
  if (!ffmpegBin || !fs.existsSync(ffmpegBin)) {
    fs.rmSync(pendingDir, { recursive: true, force: true });
    throw new Error(`ffmpeg binary not found: ${ffmpegBin}`);
  }

  const maxDecodedBytes = options?.maxDecodedBytes ?? MAX_DECODED_CLIP_BYTES;
  const timeoutMs = options?.timeoutMs ?? 30000;

  try {
    await decodeFrames(ffmpegBin, canonicalPath, pendingDir, maxDecodedBytes, timeoutMs);
  } catch (err) {
    try {
      if (fs.existsSync(pendingDir)) {
        fs.rmSync(pendingDir, { recursive: true, force: true });
      }
    } catch {}
    throw err;
  }

  const files = fs.readdirSync(pendingDir);
  const frameFiles = files.filter((f) => /^f\d{5}\.png$/.test(f)).sort();

  if (frameFiles.length === 0) {
    fs.rmSync(pendingDir, { recursive: true, force: true });
    throw new Error('No frames were decoded from video');
  }

  if (frameFiles.length > MAX_VIDEO_FRAMES) {
    fs.rmSync(pendingDir, { recursive: true, force: true });
    throw new Error(
      `Video exceeds maximum duration limit of ${MAX_VIDEO_DURATION_SEC} seconds (${frameFiles.length} frames decoded)`,
    );
  }

  let totalDecodedBytes = 0;
  for (const file of frameFiles) {
    const fileStat = fs.statSync(path.join(pendingDir, file));
    totalDecodedBytes += fileStat.size;
  }
  if (totalDecodedBytes > maxDecodedBytes) {
    fs.rmSync(pendingDir, { recursive: true, force: true });
    throw new Error(`Decoded frames exceeded limit of ${maxDecodedBytes} bytes`);
  }

  const posterFile = frameFiles[0];
  const posterPendingPath = path.join(pendingDir, posterFile);
  const posterBuf = fs.readFileSync(posterPendingPath);
  const { width: actualWidth, height: actualHeight } = parsePngDimensions(posterBuf);

  if (actualWidth <= 0 || actualHeight <= 0) {
    fs.rmSync(pendingDir, { recursive: true, force: true });
    throw new Error('Decoded frame has invalid dimensions');
  }

  const count = frameFiles.length;
  const duration = probe.duration ?? Number((count / VIDEO_FPS).toFixed(3));
  const posterFinalPath = path.join(completedDir, posterFile);

  const manifestData = {
    id,
    source: canonicalPath,
    dir: completedDir,
    poster: posterFinalPath,
    width: actualWidth,
    height: actualHeight,
    count,
    fps: VIDEO_FPS,
    duration,
    createdAt: Date.now(),
    marker: `![awrit:video](${posterFinalPath})`,
  };

  const tmpManifest = path.join(pendingDir, 'manifest.json.tmp');
  const finalManifestInPending = path.join(pendingDir, 'manifest.json');
  fs.writeFileSync(tmpManifest, JSON.stringify(manifestData, null, 2) + '\n', {
    mode: 0o600,
    flag: 'wx',
  });
  fs.chmodSync(tmpManifest, 0o600);
  fs.renameSync(tmpManifest, finalManifestInPending);

  fs.chmodSync(pendingDir, 0o700);
  fs.renameSync(pendingDir, completedDir);
  fs.chmodSync(completedDir, 0o700);

  pruneVideoCache(cacheRoot, id, options?.maxGlobalCacheBytes);

  return {
    id,
    source: canonicalPath,
    dir: completedDir,
    poster: posterFinalPath,
    width: actualWidth,
    height: actualHeight,
    count,
    fps: VIDEO_FPS,
    duration,
  };
}
