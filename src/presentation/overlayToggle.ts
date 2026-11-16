import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAppDataPath } from '../paths';
import type { ColumnSplit, PresentationLayout } from './args';
import { parsePositiveInt } from './capabilities';
import {
  buildKittyLaunchSpec,
  closeKittyWindow,
  type ExecFileFn,
  type KittyControlOptions,
  launchKitty,
  queryKittyWindows,
} from './kitty';

export interface OverlaySessionState {
  sourceWindowId: number;
  overlayWindowId?: number;
  target?: string;
  updatedAt: number;
}

export interface ToggleOverlayOptions {
  sourceWindowId: number | string;
  target?: string;
  text?: string;
  columns?: ColumnSplit;
  layout?: PresentationLayout;
  close?: boolean;
  status?: boolean;
  endpoint?: string;
  password?: string;
  kittenBinary?: string | null;
  execFileFn?: ExecFileFn;
  env?: NodeJS.ProcessEnv;
  /** Max time to wait for the viewer process to appear in the overlay window. */
  readyTimeoutMs?: number;
  readyPollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type ToggleOverlayResult =
  | {
      action: 'opened';
      id: number;
      source: number;
      target: string;
      resumed: boolean;
      /** The awrit/electron viewer process is running in the window; says nothing about frames. */
      viewerRunning: boolean;
    }
  | {
      action: 'already-open';
      id: number;
      source: number;
      target: string;
    }
  | {
      action: 'closed';
      previousId: number;
      source: number;
    }
  | {
      action: 'already-closed';
      source: number;
    }
  | {
      action: 'status';
      open: boolean;
      id?: number;
      source: number;
      target?: string;
    };

function toPositiveInt(val: unknown): number | null {
  if (typeof val === 'number') {
    return Number.isSafeInteger(val) && val > 0 ? val : null;
  }
  if (typeof val === 'string') {
    return parsePositiveInt(val);
  }
  return null;
}

function getStateFilePath(sourceWindowId: number): string {
  const dir = getAppDataPath();
  return path.join(dir, `overlay-session-${sourceWindowId}.json`);
}

function sanitizeTarget(raw?: string): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in stored target
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    throw new Error('Target must not contain control characters');
  }
  if (raw.includes('@') && /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    throw new Error('Target must not contain credentials');
  }
  return raw.trim();
}

export function loadOverlayState(sourceWindowId: number): OverlaySessionState | null {
  const filePath = getStateFilePath(sourceWindowId);
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const sourceId = toPositiveInt(parsed.sourceWindowId);
    if (sourceId === null || sourceId !== sourceWindowId) return null;

    let overlayId: number | undefined;
    if (parsed.overlayWindowId !== undefined) {
      overlayId = toPositiveInt(parsed.overlayWindowId) ?? undefined;
    }

    const target = sanitizeTarget(parsed.target);
    // Sessions saved by older releases for a device carry no target; treat them as stale.
    if (!target) return null;
    const updatedAt =
      typeof parsed.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
        ? parsed.updatedAt
        : Date.now();

    return {
      sourceWindowId: sourceId,
      overlayWindowId: overlayId,
      target,
      updatedAt,
    };
  } catch {
    return null;
  }
}

export function saveOverlayState(state: OverlaySessionState): void {
  const filePath = getStateFilePath(state.sourceWindowId);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const tmpPath = `${filePath}.${randomBytes(6).toString('hex')}.tmp`;
  const data = JSON.stringify(
    {
      sourceWindowId: state.sourceWindowId,
      overlayWindowId: state.overlayWindowId,
      target: state.target,
      updatedAt: state.updatedAt,
    },
    null,
    2,
  );

  try {
    fs.writeFileSync(tmpPath, `${data}\n`, { mode: 0o600, flag: 'wx' });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {}
    throw error;
  }
}

export function clearOverlayState(sourceWindowId: number): void {
  const filePath = getStateFilePath(sourceWindowId);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {}
}

export async function isOverlayAlive(
  sourceWindowId: number,
  overlayWindowId: number,
  options: KittyControlOptions = {},
): Promise<boolean> {
  try {
    const osWindows = await queryKittyWindows(options);

    for (const osWin of osWindows) {
      if (!Array.isArray(osWin?.tabs)) continue;
      for (const tab of osWin.tabs) {
        if (!Array.isArray(tab?.windows)) continue;
        let hasSource = false;
        let hasOverlay = false;
        for (const win of tab.windows) {
          if (win?.id === sourceWindowId) hasSource = true;
          if (win?.id === overlayWindowId) hasOverlay = true;
        }
        if (hasSource) {
          return hasOverlay;
        }
      }
    }
    return false;
  } catch {
    return false;
  }
}

const VIEWER_PATTERN = /awrit|electron/i;

type ViewerState = 'running' | 'pending' | 'gone';

async function viewerState(
  sourceId: number,
  windowId: number,
  options: KittyControlOptions,
): Promise<ViewerState> {
  const osWindows = await queryKittyWindows(options);
  for (const osWin of osWindows) {
    for (const tab of osWin?.tabs ?? []) {
      const wins: any[] = tab?.windows ?? [];
      if (!wins.some((w) => w?.id === sourceId)) continue;
      const win = wins.find((w) => w?.id === windowId);
      if (!win) return 'gone';
      const running = (win.foreground_processes ?? []).some((p: any) =>
        (Array.isArray(p?.cmdline) ? p.cmdline : []).some((c: unknown) =>
          VIEWER_PATTERN.test(String(c)),
        ),
      );
      return running ? 'running' : 'pending';
    }
  }
  return 'gone';
}

export async function toggleOverlay(options: ToggleOverlayOptions): Promise<ToggleOverlayResult> {
  let sourceId = toPositiveInt(options.sourceWindowId);
  const env = options.env ?? process.env;

  // Self-healing: if sourceWindowId is invalid or endpoint is unverified, resolve via kittyDiscovery
  if (sourceId === null || !options.endpoint) {
    try {
      const { resolveKittyContext } = await import('./kittyDiscovery');
      const ctx = await resolveKittyContext({
        endpoint: options.endpoint,
        sourceWindowId: options.sourceWindowId,
        env,
        timeoutMs: 40,
      });
      if (ctx) {
        if (!options.endpoint) options.endpoint = ctx.endpoint;
        if (sourceId === null && ctx.sourceWindowId) {
          sourceId = ctx.sourceWindowId;
        }
      }
    } catch {}
  }

  if (sourceId === null || !Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error(`Invalid source window ID: ${options.sourceWindowId}`);
  }

  if (options.close && options.status) {
    throw new Error('Cannot specify both close and status');
  }

  const controlOpts: KittyControlOptions = {
    endpoint: options.endpoint,
    password: options.password,
    execFileFn: options.execFileFn,
    env: options.env,
    kittenBinary: options.kittenBinary,
  };

  let state = loadOverlayState(sourceId);

  // Status check
  if (options.status) {
    if (state?.overlayWindowId) {
      const alive = await isOverlayAlive(sourceId, state.overlayWindowId, controlOpts);
      if (alive) {
        return {
          action: 'status',
          open: true,
          id: state.overlayWindowId,
          source: sourceId,
          target: state.target,
        };
      }
      // Stale ID, clear it
      state = { ...state, overlayWindowId: undefined, updatedAt: Date.now() };
      saveOverlayState(state);
    }
    return {
      action: 'status',
      open: false,
      source: sourceId,
      target: state?.target,
    };
  }

  // Close request
  if (options.close) {
    if (state?.overlayWindowId) {
      const alive = await isOverlayAlive(sourceId, state.overlayWindowId, controlOpts);
      if (alive) {
        await closeKittyWindow(state.overlayWindowId, controlOpts);
        const previousId = state.overlayWindowId;
        saveOverlayState({
          ...state,
          overlayWindowId: undefined,
          updatedAt: Date.now(),
        });
        return { action: 'closed', previousId, source: sourceId };
      }
      // Was already closed externally
      saveOverlayState({
        ...state,
        overlayWindowId: undefined,
        updatedAt: Date.now(),
      });
      return { action: 'already-closed', source: sourceId };
    }
    return { action: 'already-closed', source: sourceId };
  }

  // Open / Toggle request
  const newTarget = sanitizeTarget(options.target);

  if (state?.overlayWindowId) {
    const alive = await isOverlayAlive(sourceId, state.overlayWindowId, controlOpts);
    if (alive) {
      const hasDifferentTarget = newTarget !== undefined && newTarget !== state.target;

      if (!hasDifferentTarget) {
        return {
          action: 'already-open',
          id: state.overlayWindowId,
          source: sourceId,
          target: state.target || '',
        };
      }
      // Close the old target before opening the new one
      await closeKittyWindow(state.overlayWindowId, controlOpts);
    }
  }

  // Determine target for open: explicit new target or resumed from state
  let resolvedTarget = newTarget;
  let resumed = false;

  if (!resolvedTarget && state) {
    resolvedTarget = state.target;
    resumed = true;
  }

  if (!resolvedTarget) {
    throw new Error('A target is required to open an overlay (no previous target found)');
  }

  let launchSpec: ReturnType<typeof buildKittyLaunchSpec> | undefined;
  if (options.text !== undefined) {
    launchSpec = buildKittyLaunchSpec({
      target: resolvedTarget,
      env: options.env,
    });
    launchSpec.argv.push(
      '--presentation-json',
      JSON.stringify({ text: options.text, layout: options.layout, columns: options.columns }),
    );
  }

  const receipt = await launchKitty({
    sourceWindowId: sourceId,
    mode: 'overlay',
    ...(launchSpec ? { launchSpec } : { target: resolvedTarget }),
    endpoint: options.endpoint,
    password: options.password,
    execFileFn: options.execFileFn,
    env: options.env,
    kittenBinary: options.kittenBinary,
  });

  const nextState: OverlaySessionState = {
    sourceWindowId: sourceId,
    overlayWindowId: receipt.id,
    target: resolvedTarget,
    updatedAt: Date.now(),
  };
  saveOverlayState(nextState);

  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const deadline = now() + (options.readyTimeoutMs ?? 15000);
  let viewerRunning = false;
  for (;;) {
    const st = await viewerState(sourceId, receipt.id, controlOpts);
    if (st === 'gone') {
      saveOverlayState({ ...nextState, overlayWindowId: undefined, updatedAt: Date.now() });
      throw new Error(
        `Overlay window ${receipt.id} closed before the viewer started; check that awrit can launch`,
      );
    }
    if (st === 'running') {
      viewerRunning = true;
      break;
    }
    if (now() >= deadline) break;
    await sleep(options.readyPollMs ?? 250);
  }

  return {
    action: 'opened',
    id: receipt.id,
    source: sourceId,
    target: resolvedTarget || '',
    resumed,
    viewerRunning,
  };
}
