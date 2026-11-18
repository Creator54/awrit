import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as Electron from 'electron';
import type { PresentationTarget } from './target';

export interface CaptureMainConfig {
  target: PresentationTarget;
  out: string;
  viewport: { width: number; height: number };
  overwrite: boolean;
  loadTimeoutMs: number;
  fontTimeoutMs: number;
  waitMs?: number;
  waitSelector?: string;
}

export interface CaptureResultPayload {
  __awrit_capture_result__: true;
  success: boolean;
  outPath?: string;
  width?: number;
  height?: number;
  byteLength?: number;
  error?: string;
  code?: string;
}

const MAX_VIEWPORT_SIDE = 4096;
const MAX_VIEWPORT_PIXELS = 8_388_608;

export function parseCaptureMainArgs(argv: string[]): CaptureMainConfig | null {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--config-json') {
      const raw = argv[++i];
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return null;

        const { target, out, viewport, overwrite, loadTimeoutMs, fontTimeoutMs, waitMs, waitSelector } = parsed;

        // Strict target validation
        if (!target || typeof target !== 'object') return null;
        if (target.kind === 'file') {
          if (typeof target.path !== 'string' || !target.path.trim()) return null;
          if (typeof target.url !== 'string' || !target.url.startsWith('file://')) return null;
        } else if (target.kind === 'url') {
          if (typeof target.url !== 'string' || !/^https?:\/\//i.test(target.url)) return null;
        } else {
          return null;
        }

        // Strict out validation
        if (typeof out !== 'string' || !out.trim()) return null;

        // Strict viewport validation
        if (!viewport || typeof viewport !== 'object') return null;
        const width = viewport.width;
        const height = viewport.height;
        if (
          typeof width !== 'number' ||
          typeof height !== 'number' ||
          !Number.isSafeInteger(width) ||
          !Number.isSafeInteger(height) ||
          width < 1 ||
          height < 1 ||
          width > MAX_VIEWPORT_SIDE ||
          height > MAX_VIEWPORT_SIDE ||
          width * height > MAX_VIEWPORT_PIXELS
        ) {
          return null;
        }

        const loadTimeout = Number(loadTimeoutMs);
        const fontTimeout = Number(fontTimeoutMs);
        const parsedWaitMs = waitMs !== undefined ? Number(waitMs) : undefined;
        const parsedWaitSelector = typeof waitSelector === 'string' && waitSelector.trim() ? waitSelector.trim() : undefined;

        return {
          target,
          out,
          viewport: { width, height },
          overwrite: Boolean(overwrite),
          loadTimeoutMs: Number.isFinite(loadTimeout) && loadTimeout > 0 ? loadTimeout : 15000,
          fontTimeoutMs: Number.isFinite(fontTimeout) && fontTimeout >= 0 ? fontTimeout : 2000,
          ...(parsedWaitMs !== undefined && Number.isFinite(parsedWaitMs) && parsedWaitMs >= 0 ? { waitMs: parsedWaitMs } : {}),
          ...(parsedWaitSelector ? { waitSelector: parsedWaitSelector } : {}),
        };
      } catch {
        return null;
      }
    }
  }

  return null;
}

export function isAllowedNavigation(target: PresentationTarget, navigationUrl: string): boolean {
  if (target.kind === 'file') {
    // Only navigation within the same canonical file is allowed
    try {
      const navUrl = new URL(navigationUrl);
      const targetUrl = new URL(target.url);
      if (navUrl.protocol !== 'file:') return false;
      return fileURLToPath(navUrl) === fileURLToPath(targetUrl);
    } catch {
      return false;
    }
  }

  if (target.kind === 'url') {
    try {
      const parsed = new URL(navigationUrl);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return false;
      }
      if (parsed.username || parsed.password) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

export function isAllowedSubresource(target: PresentationTarget, requestedUrl: string): boolean {
  try {
    const parsed = new URL(requestedUrl);

    // Remote targets must never load local files
    if (target.kind === 'url') {
      if (parsed.protocol === 'file:') return false;
      if (/^(chrome|devtools):/i.test(parsed.protocol)) return false;
      return true;
    }

    // File targets:
    if (target.kind === 'file') {
      if (parsed.protocol === 'file:') {
        const requestedPath = fileURLToPath(parsed);
        // Canonical directory containment check to prevent symlink traversal escapes
        let targetDirCanonical: string;
        let requestedCanonical: string;
        try {
          targetDirCanonical = fs.realpathSync(path.dirname(target.path));
          requestedCanonical = fs.realpathSync(requestedPath);
        } catch {
          return false;
        }

        const rel = path.relative(targetDirCanonical, requestedCanonical);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          return false;
        }
        return true;
      }

      // Sibling remote assets (e.g. web fonts, images)
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return !parsed.username && !parsed.password;
      }
      if (parsed.protocol === 'data:' || parsed.protocol === 'blob:') {
        return true;
      }
      return false;
    }
  } catch {
    return false;
  }
  return false;
}

export function writePngOutputSecurely(
  outPath: string,
  pngBuffer: Buffer,
  overwrite: boolean,
): void {
  const resolvedOut = path.resolve(outPath);
  const targetDir = path.dirname(resolvedOut);
  fs.mkdirSync(targetDir, { recursive: true });

  const tempOut = path.join(
    targetDir,
    `.tmp.${path.basename(resolvedOut)}.${Date.now()}.${Math.random().toString(36).slice(2)}`,
  );

  // Write to adjacent temp file exclusively first
  fs.writeFileSync(tempOut, pngBuffer, { flag: 'wx' });

  try {
    if (overwrite) {
      fs.renameSync(tempOut, resolvedOut);
    } else {
      // Atomic link preserves destination and fails with EEXIST if destination already exists
      try {
        fs.linkSync(tempOut, resolvedOut);
        fs.unlinkSync(tempOut);
      } catch (err: any) {
        try {
          fs.unlinkSync(tempOut);
        } catch {}
        if (err.code === 'EEXIST') {
          throw new Error(
            `Output file already exists: ${resolvedOut} (use --overwrite to allow overwriting)`,
          );
        }
        throw err;
      }
    }
  } catch (err) {
    try {
      if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
    } catch {}
    throw err;
  }
}

export function emitResult(payload: CaptureResultPayload): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function runCaptureInElectron(config: CaptureMainConfig): void {
  const electron: typeof Electron = require('electron');
  const { app, BrowserWindow, session } = electron;

  const ses = session.fromPartition(
    `capture-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    {
      cache: false,
    },
  );

  ses.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });
  ses.setPermissionCheckHandler(() => false);
  if (typeof (ses as any).setDevicePermissionHandler === 'function') {
    (ses as any).setDevicePermissionHandler(() => false);
  }
  ses.on('will-download', (event) => {
    event.preventDefault();
  });

  let activeRequests = 0;
  let onIdleCheck: (() => void) | null = null;

  ses.webRequest.onBeforeRequest((details, callback) => {
    if (!isAllowedSubresource(config.target, details.url)) {
      callback({ cancel: true });
      return;
    }
    // Track in-flight remote requests (skip data/file/devtools)
    if (/^https?:\/\//i.test(details.url)) {
      activeRequests++;
    }
    callback({ cancel: false });
  });

  const decrementAndCheckIdle = (details: { url: string }) => {
    if (/^https?:\/\//i.test(details.url) && activeRequests > 0) {
      activeRequests--;
      if (activeRequests <= 1 && onIdleCheck) {
        onIdleCheck();
      }
    }
  };

  ses.webRequest.onCompleted(decrementAndCheckIdle);
  ses.webRequest.onErrorOccurred(decrementAndCheckIdle);

  const win = new BrowserWindow({
    show: false,
    paintWhenInitiallyHidden: true,
    width: config.viewport.width,
    height: config.viewport.height,
    useContentSize: true,
    frame: false,
    enableLargerThanScreen: true,
    webPreferences: {
      offscreen: true,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      session: ses,
    },
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.webContents.on('will-navigate', (event, navigationUrl) => {
    if (!isAllowedNavigation(config.target, navigationUrl)) {
      event.preventDefault();
    }
  });

  win.webContents.on('will-redirect', (event, redirectUrl) => {
    if (!isAllowedNavigation(config.target, redirectUrl)) {
      event.preventDefault();
    }
  });

  const loadPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      win.webContents.removeListener('did-finish-load', onFinish);
      win.webContents.removeListener('did-fail-load', onFail);
    };

    const onFinish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };

    const onFail = (
      _event: any,
      errorCode: number,
      errorDescription: string,
      validatedURL: string,
      isMainFrame?: boolean,
    ) => {
      if (isMainFrame !== false && !settled) {
        settled = true;
        cleanup();
        reject(new Error(`Failed to load ${validatedURL}: ${errorDescription} (${errorCode})`));
      }
    };

    win.webContents.once('did-finish-load', onFinish);
    win.webContents.once('did-fail-load', onFail);

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        win.webContents.stop();
      } catch {}
      reject(new Error(`Page load timed out after ${config.loadTimeoutMs}ms`));
    }, config.loadTimeoutMs);

    win.loadURL(config.target.url).catch((err) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(err);
      }
    });
  });

  loadPromise
    .then(async () => {
      // 1. Network & DOM settle check for web targets
      if (config.target.kind === 'url') {
        const networkIdlePromise = new Promise<void>((resolve) => {
          let quietTimer: NodeJS.Timeout | null = null;
          const maxIdleTimer = setTimeout(() => {
            if (quietTimer) clearTimeout(quietTimer);
            onIdleCheck = null;
            resolve();
          }, 3500); // 3.5s hard cap post-load so slow polling never hangs

          const check = () => {
            if (activeRequests <= 1) {
              if (quietTimer) clearTimeout(quietTimer);
              quietTimer = setTimeout(() => {
                clearTimeout(maxIdleTimer);
                onIdleCheck = null;
                resolve();
              }, 300); // 300ms quiet window with <= 1 active request
            }
          };

          onIdleCheck = check;
          check();
        });
        await networkIdlePromise;
      }

      // 2. Wait for explicit selector if requested
      if (config.waitSelector) {
        const selector = JSON.stringify(config.waitSelector);
        const pollStart = Date.now();
        const maxWait = Math.min(config.loadTimeoutMs, 10000);
        while (Date.now() - pollStart < maxWait) {
          try {
            const found = await win.webContents.executeJavaScript(
              `Boolean(document.querySelector(${selector}))`,
              true,
            );
            if (found) break;
          } catch {}
          await new Promise((r) => setTimeout(r, 100));
        }
      }

      // 3. Explicit waitMs delay if requested
      if (config.waitMs && config.waitMs > 0) {
        await new Promise((r) => setTimeout(r, config.waitMs));
      }

      // 4. Bounded font settle
      try {
        await Promise.race([
          win.webContents.executeJavaScript(
            'document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()',
            true,
          ),
          new Promise((resolve) => setTimeout(resolve, config.fontTimeoutMs)),
        ]);
      } catch {}

      // 5. Double frame flush to commit pending DOM/layout/paint cycles to compositor
      try {
        await win.webContents.executeJavaScript(
          `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`,
          true,
        );
      } catch {}

      const nativeImage = await win.webContents.capturePage({
        x: 0,
        y: 0,
        width: config.viewport.width,
        height: config.viewport.height,
      });

      const pngBuffer = nativeImage.toPNG();
      if (pngBuffer.length === 0) {
        throw new Error('capturePage produced empty PNG buffer');
      }

      const outPath = path.resolve(config.out);
      writePngOutputSecurely(outPath, pngBuffer, config.overwrite);

      emitResult({
        __awrit_capture_result__: true,
        success: true,
        outPath,
        width: config.viewport.width,
        height: config.viewport.height,
        byteLength: pngBuffer.length,
      });

      try {
        win.destroy();
      } catch {}
      app.exit(0);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        error instanceof Error && 'code' in error ? String((error as any).code) : 'CAPTURE_FAILED';

      emitResult({
        __awrit_capture_result__: true,
        success: false,
        error: message,
        code,
      });

      try {
        win.destroy();
      } catch {}
      app.exit(1);
    });
}

function start(): void {
  // Only execute when spawned as child worker with explicit marker
  if (process.env.AWRIT_CAPTURE_CHILD !== '1') {
    return;
  }
  if (typeof process === 'undefined' || !process.versions?.electron) {
    return;
  }

  const args = process.argv.slice(2);
  const config = parseCaptureMainArgs(args);
  if (!config) {
    emitResult({
      __awrit_capture_result__: true,
      success: false,
      error: 'Invalid or missing captureMain configuration arguments',
      code: 'INVALID_ARGS',
    });
    const electron: typeof Electron = require('electron');
    electron.app.exit(1);
    return;
  }

  const electron: typeof Electron = require('electron');
  const { app } = electron;

  app
    .whenReady()
    .then(() => {
      runCaptureInElectron(config);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      emitResult({
        __awrit_capture_result__: true,
        success: false,
        error: message,
        code: 'APP_READY_FAILED',
      });
      app.exit(1);
    });
}

start();
