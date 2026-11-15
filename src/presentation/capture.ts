import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { CaptureMainConfig, CaptureResultPayload } from './captureMain';
import { type PresentationTarget, resolvePresentationTarget } from './target';

export const MAX_VIEWPORT_SIDE = 4096;
export const MAX_VIEWPORT_PIXELS = 8_388_608; // 8 Megapixels
export const MAX_OUTPUT_BUFFER_BYTES = 512 * 1024; // 512 KiB

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface ViewportDimensions {
  width: number;
  height: number;
}

export interface CaptureSnapshotOptions {
  target: string | PresentationTarget;
  out: string;
  viewport?: ViewportDimensions;
  overwrite?: boolean;
  electronPath?: string;
  entryPath: string;
  timeoutMs?: number;
  loadTimeoutMs?: number;
  fontTimeoutMs?: number;
  waitMs?: number;
  waitSelector?: string;
  cwd?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

export interface CaptureSnapshotResult {
  outPath: string;
  width: number;
  height: number;
  byteLength: number;
}

export class CaptureError extends Error {
  readonly code: string;
  constructor(message: string, code = 'CAPTURE_ERROR') {
    super(message);
    this.name = 'CaptureError';
    this.code = code;
  }
}

export function validateViewport(viewport?: ViewportDimensions): ViewportDimensions {
  if (!viewport) {
    return { width: 1280, height: 800 };
  }
  const { width, height } = viewport;
  if (
    typeof width !== 'number' ||
    typeof height !== 'number' ||
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1
  ) {
    throw new CaptureError('Viewport dimensions must be positive integers', 'INVALID_VIEWPORT');
  }
  if (
    width > MAX_VIEWPORT_SIDE ||
    height > MAX_VIEWPORT_SIDE ||
    width * height > MAX_VIEWPORT_PIXELS
  ) {
    throw new CaptureError(
      'Viewport exceeds the 4096-side / 8-megapixel limit',
      'INVALID_VIEWPORT',
    );
  }
  return { width, height };
}

export function resolveElectronFromLauncher(launcherPath?: string): {
  electronPath?: string;
  ldLibraryPath?: string;
} {
  const candidate =
    launcherPath ?? process.env.AWRIT_LAUNCHER ?? path.resolve(process.cwd(), 'result/bin/awrit');
  if (!fs.existsSync(candidate)) return {};
  try {
    const content = fs.readFileSync(candidate, 'utf8');
    const ldMatch = /export\s+LD_LIBRARY_PATH="([^"$]+)/.exec(content);
    const execMatch = /exec\s+"([^"]+electron)"/.exec(content);
    return {
      electronPath: execMatch?.[1],
      ldLibraryPath: ldMatch?.[1],
    };
  } catch {
    return {};
  }
}

export function verifyPngHeaderAndDimensions(
  filePath: string,
  expectedWidth: number,
  expectedHeight: number,
): void {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(24);
  try {
    const bytesRead = fs.readSync(fd, buffer, 0, 24, 0);
    if (bytesRead < 24) {
      throw new CaptureError('Invalid PNG file: header too short', 'INVALID_PNG');
    }
  } finally {
    fs.closeSync(fd);
  }

  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new CaptureError('Output file is not a valid PNG image', 'INVALID_PNG');
  }

  const chunkType = buffer.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    throw new CaptureError('Invalid PNG file: missing IHDR chunk', 'INVALID_PNG');
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);

  if (width !== expectedWidth || height !== expectedHeight) {
    throw new CaptureError(
      `PNG dimensions mismatch: expected ${expectedWidth}x${expectedHeight}, got ${width}x${height}`,
      'DIMENSION_MISMATCH',
    );
  }
}

export async function captureSnapshot(
  options: CaptureSnapshotOptions,
): Promise<CaptureSnapshotResult> {
  if (options.signal?.aborted) {
    throw new CaptureError('Capture aborted by signal', 'ABORTED');
  }

  let electronPath = options.electronPath?.trim();
  let defaultLdLib: string | undefined;

  if (!electronPath) {
    const fromLauncher = resolveElectronFromLauncher();
    electronPath = fromLauncher.electronPath;
    defaultLdLib = fromLauncher.ldLibraryPath;
  }

  if (!electronPath) {
    throw new CaptureError('electronPath is required', 'MISSING_ELECTRON_PATH');
  }

  if (!options.entryPath || !options.entryPath.trim()) {
    throw new CaptureError('entryPath is required', 'MISSING_ENTRY_PATH');
  }

  const cwd = options.cwd ?? process.cwd();
  const resolvedTarget =
    typeof options.target === 'string'
      ? resolvePresentationTarget(options.target, cwd)
      : options.target;

  if (!resolvedTarget || !resolvedTarget.url) {
    throw new CaptureError('Invalid presentation target', 'INVALID_TARGET');
  }

  if (!options.out || !options.out.trim()) {
    throw new CaptureError('Output path is required', 'INVALID_OUT');
  }

  const resolvedOut = path.resolve(cwd, options.out);
  const overwrite = Boolean(options.overwrite);

  if (!overwrite && fs.existsSync(resolvedOut)) {
    throw new CaptureError(
      `Output file already exists: ${resolvedOut} (use overwrite to allow overwriting)`,
      'FILE_EXISTS',
    );
  }

  const viewport = validateViewport(options.viewport);

  // Strict positive finite timeout validation
  const timeoutMs = options.timeoutMs ?? 30000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 300000) {
    throw new CaptureError('timeoutMs must be a positive number up to 300000', 'INVALID_TIMEOUT');
  }

  const loadTimeoutMs = options.loadTimeoutMs ?? 15000;
  if (!Number.isFinite(loadTimeoutMs) || loadTimeoutMs <= 0 || loadTimeoutMs > 120000) {
    throw new CaptureError(
      'loadTimeoutMs must be a positive number up to 120000',
      'INVALID_TIMEOUT',
    );
  }

  const fontTimeoutMs = options.fontTimeoutMs ?? 2000;
  if (!Number.isFinite(fontTimeoutMs) || fontTimeoutMs < 0 || fontTimeoutMs > 30000) {
    throw new CaptureError(
      'fontTimeoutMs must be a non-negative number up to 30000',
      'INVALID_TIMEOUT',
    );
  }

  const config: CaptureMainConfig = {
    target: resolvedTarget,
    out: resolvedOut,
    viewport,
    overwrite,
    loadTimeoutMs,
    fontTimeoutMs,
    ...(options.waitMs !== undefined ? { waitMs: options.waitMs } : {}),
    ...(options.waitSelector !== undefined ? { waitSelector: options.waitSelector } : {}),
  };

  const configJson = JSON.stringify(config);
  const args = [options.entryPath, '--config-json', configJson];

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    AWRIT_CAPTURE_CHILD: '1',
    ...(defaultLdLib && !process.env.LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: defaultLdLib } : {}),
    ...options.env,
  };

  return new Promise<CaptureSnapshotResult>((resolve, reject) => {
    let child: ChildProcess | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;
    let killTimer: NodeJS.Timeout | null = null;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;

    const cleanup = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
      if (options.signal) {
        options.signal.removeEventListener('abort', onAbort);
      }
    };

    const terminateChild = () => {
      if (!child || child.exitCode !== null || child.signalCode !== null) return;
      try {
        child.kill('SIGTERM');
      } catch {}

      killTimer = setTimeout(() => {
        try {
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
          }
        } catch {}
      }, 2000);
    };

    const onAbort = () => {
      if (settled) return;
      settled = true;
      terminateChild();
      reject(new CaptureError('Capture aborted by signal', 'ABORTED'));
    };

    if (options.signal) {
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      child = spawn(electronPath, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: childEnv,
      });
    } catch (err) {
      cleanup();
      const message = err instanceof Error ? err.message : String(err);
      reject(new CaptureError(`Failed to spawn Electron: ${message}`, 'SPAWN_FAILED'));
      return;
    }

    timeoutTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      terminateChild();
      reject(new CaptureError(`Capture timed out after ${timeoutMs}ms`, 'TIMEOUT'));
    }, timeoutMs);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdoutBuffer.length < MAX_OUTPUT_BUFFER_BYTES) {
        const remaining = MAX_OUTPUT_BUFFER_BYTES - stdoutBuffer.length;
        stdoutBuffer += chunk.toString('utf8', 0, remaining);
      }
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      if (stderrBuffer.length < MAX_OUTPUT_BUFFER_BYTES) {
        const remaining = MAX_OUTPUT_BUFFER_BYTES - stderrBuffer.length;
        stderrBuffer += chunk.toString('utf8', 0, remaining);
      }
    });

    child.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      terminateChild();
      reject(new CaptureError(`Process execution error: ${err.message}`, 'EXEC_ERROR'));
    });

    child.on('close', (code, _signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      // Find result payload in stdout
      let payload: CaptureResultPayload | null = null;
      const lines = stdoutBuffer.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{') && trimmed.includes('"__awrit_capture_result__":')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed?.__awrit_capture_result__ === true) {
              payload = parsed;
              break;
            }
          } catch {}
        }
      }

      if (code === 0 && payload?.success && payload.outPath) {
        if (payload.outPath !== resolvedOut) {
          reject(
            new CaptureError(
              `Mismatched output path: expected ${resolvedOut}, got ${payload.outPath}`,
              'PATH_MISMATCH',
            ),
          );
          return;
        }

        if (!fs.existsSync(resolvedOut)) {
          reject(
            new CaptureError(
              `Capture reported success but output file not found: ${resolvedOut}`,
              'OUTPUT_MISSING',
            ),
          );
          return;
        }

        try {
          verifyPngHeaderAndDimensions(resolvedOut, viewport.width, viewport.height);
          const stat = fs.statSync(resolvedOut);
          resolve({
            outPath: resolvedOut,
            width: viewport.width,
            height: viewport.height,
            byteLength: stat.size,
          });
        } catch (err) {
          reject(err);
        }
        return;
      }

      if (payload && !payload.success) {
        reject(
          new CaptureError(
            payload.error ?? 'Capture failed in Electron process',
            payload.code ?? 'CAPTURE_FAILED',
          ),
        );
        return;
      }

      if (code !== 0) {
        const sanitizedStderr = stderrBuffer.trim().slice(0, 500);
        const errDetail = sanitizedStderr ? `: ${sanitizedStderr}` : '';
        reject(
          new CaptureError(
            `Electron process exited with status ${code}${errDetail}`,
            'PROCESS_EXIT_ERROR',
          ),
        );
        return;
      }

      reject(
        new CaptureError('Electron process completed without emitting capture result', 'NO_RESULT'),
      );
    });
  });
}
