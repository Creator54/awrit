import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export interface ResolvedKittyContext {
  endpoint: string;
  sourceWindowId?: number;
  kittyPid?: number;
  method: 'env-verified' | 'ancestor-walk' | 'fs-scan' | 'fallback';
}

/**
 * Fast-probe a UNIX socket path or tcp endpoint with a short timeout (default 40ms).
 */
export async function probeSocket(endpoint: string, timeoutMs = 40): Promise<boolean> {
  if (!endpoint || typeof endpoint !== 'string') return false;
  const trimmed = endpoint.trim();
  if (!trimmed.startsWith('unix:')) return false;

  const sockPath = trimmed.replace(/^unix:/, '');
  try {
    if (!fs.existsSync(sockPath)) return false;
    const stat = fs.statSync(sockPath);
    if (!stat.isSocket()) return false;
    // Security check: must be owned by the current user
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      return false;
    }
  } catch {
    return false;
  }

  return new Promise<boolean>((resolve) => {
    let resolved = false;
    const client = net.connect(sockPath);
    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        client.destroy();
        resolve(false);
      }
    }, timeoutMs);

    client.on('connect', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        client.destroy();
        resolve(true);
      }
    });

    client.on('error', () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        client.destroy();
        resolve(false);
      }
    });
  });
}

/**
 * Collect process ancestor PIDs by walking /proc/<pid>/stat on Linux
 */
export function getProcessAncestors(startPid = process.pid): number[] {
  const ancestors: number[] = [startPid];
  let curr = startPid;

  for (let i = 0; i < 30; i++) {
    try {
      if (process.platform === 'linux') {
        const statPath = `/proc/${curr}/stat`;
        if (!fs.existsSync(statPath)) break;
        const content = fs.readFileSync(statPath, 'utf8');
        // Format: pid (comm) state ppid ...
        const match = content.match(/\)\s+[A-Z]\s+(\d+)/);
        if (!match) break;
        const ppid = parseInt(match[1], 10);
        if (!Number.isInteger(ppid) || ppid <= 1 || ppid === curr) break;
        ancestors.push(ppid);
        curr = ppid;
      } else {
        break;
      }
    } catch {
      break;
    }
  }

  return ancestors;
}

/**
 * Scan candidate directories for active, live Kitty sockets owned by the current user
 */
export function findCandidateKittySockets(): Array<{ path: string; pid?: number }> {
  const candidates: Array<{ path: string; pid?: number }> = [];
  const dirs = [
    process.env.XDG_RUNTIME_DIR,
    os.tmpdir(),
    '/tmp',
  ].filter(Boolean) as string[];

  const myUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const seenPaths = new Set<string>();

  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (!entry.startsWith('kitty-')) continue;
        const fullPath = path.join(dir, entry);
        if (seenPaths.has(fullPath)) continue;
        seenPaths.add(fullPath);

        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isSocket()) continue;
          if (myUid !== undefined && stat.uid !== myUid) continue;

          const match = entry.match(/kitty-(\d+)/);
          const pid = match ? parseInt(match[1], 10) : undefined;

          // If PID is extracted, verify process liveness
          if (pid) {
            try {
              process.kill(pid, 0);
            } catch {
              // Dead process, skip stale socket
              continue;
            }
          }

          candidates.push({ path: fullPath, pid });
        } catch {}
      }
    } catch {}
  }

  return candidates;
}

/**
 * Correlate caller or ancestor PIDs to a window in kitten @ ls JSON
 */
export function correlateWindowIdFromLs(
  osWindows: any[],
  ancestorPids: number[],
  preferredWindowId?: number | null,
): number | null {
  if (!Array.isArray(osWindows) || osWindows.length === 0) return null;

  // 1. If preferredWindowId is valid and present in the session tree, verify it
  if (preferredWindowId) {
    for (const osWin of osWindows) {
      if (!Array.isArray(osWin?.tabs)) continue;
      for (const tab of osWin.tabs) {
        if (!Array.isArray(tab?.windows)) continue;
        for (const win of tab.windows) {
          if (win?.id === preferredWindowId) return preferredWindowId;
        }
      }
    }
  }

  const ancestorSet = new Set(ancestorPids);

  // 2. Correlate by window.pid or foreground_processes[].pid
  for (const osWin of osWindows) {
    if (!Array.isArray(osWin?.tabs)) continue;
    for (const tab of osWin.tabs) {
      if (!Array.isArray(tab?.windows)) continue;
      for (const win of tab.windows) {
        if (win?.pid && ancestorSet.has(win.pid)) {
          return win.id;
        }
        if (Array.isArray(win?.foreground_processes)) {
          for (const proc of win.foreground_processes) {
            if (proc?.pid && ancestorSet.has(proc.pid)) {
              return win.id;
            }
          }
        }
      }
    }
  }

  // 3. Fallback: Find focused window
  for (const osWin of osWindows) {
    if (!Array.isArray(osWin?.tabs)) continue;
    for (const tab of osWin.tabs) {
      if (!Array.isArray(tab?.windows)) continue;
      for (const win of tab.windows) {
        if (win?.is_focused || (osWin.is_focused && tab.is_focused && win.is_active)) {
          return win.id;
        }
      }
    }
  }

  // 4. Last resort: Return first available window
  const firstWin = osWindows[0]?.tabs?.[0]?.windows?.[0];
  if (firstWin?.id) return firstWin.id;

  return null;
}

/**
 * Discover the live Kitty endpoint and active source window ID
 */
export async function resolveKittyContext(options: {
  endpoint?: string;
  sourceWindowId?: number | string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
} = {}): Promise<ResolvedKittyContext | null> {
  const env = options.env ?? process.env;
  const initialEndpoint = options.endpoint ?? env.KITTY_LISTEN_ON;
  // A TUIOS pane id is not a Kitty window; parseInt would read its leading digits as one.
  const initialWindowId = options.sourceWindowId && /^[0-9]+$/.test(String(options.sourceWindowId))
    ? parseInt(String(options.sourceWindowId), 10)
    : env.KITTY_WINDOW_ID
      ? parseInt(env.KITTY_WINDOW_ID, 10)
      : null;

  // 1. Check if initialEndpoint is healthy
  if (initialEndpoint && (await probeSocket(initialEndpoint, options.timeoutMs ?? 40))) {
    return {
      endpoint: initialEndpoint,
      sourceWindowId: Number.isInteger(initialWindowId) ? (initialWindowId as number) : undefined,
      method: 'env-verified',
    };
  }

  // 2. Auto-discovery: inspect ancestor PIDs
  const ancestors = getProcessAncestors();
  const candidates = findCandidateKittySockets();

  // Try to find a socket whose PID is in our ancestor tree
  let liveEndpoint: string | null = null;
  let matchedPid: number | undefined;

  for (const c of candidates) {
    if (c.pid && ancestors.includes(c.pid)) {
      if (await probeSocket(`unix:${c.path}`, options.timeoutMs ?? 40)) {
        liveEndpoint = `unix:${c.path}`;
        matchedPid = c.pid;
        break;
      }
    }
  }

  // 3. If no ancestor matched, probe candidate sockets
  if (!liveEndpoint) {
    for (const c of candidates) {
      if (await probeSocket(`unix:${c.path}`, options.timeoutMs ?? 40)) {
        liveEndpoint = `unix:${c.path}`;
        matchedPid = c.pid;
        break;
      }
    }
  }

  if (!liveEndpoint) {
    return null;
  }

  let resolvedWinId = Number.isInteger(initialWindowId) ? (initialWindowId as number) : undefined;
  try {
    const { queryKittyWindows } = await import('./kitty');
    const osWindows = await queryKittyWindows({ endpoint: liveEndpoint, env });
    const correlated = correlateWindowIdFromLs(osWindows, ancestors, resolvedWinId);
    if (correlated) {
      resolvedWinId = correlated;
    }
  } catch {}

  return {
    endpoint: liveEndpoint,
    sourceWindowId: resolvedWinId,
    kittyPid: matchedPid,
    method: 'fs-scan',
  };
}

/**
 * Discover the neighboring window ID in the same tab, if any.
 * Useful when launched via Kitty manual split/tab mapping where source-window-id is not explicitly passed.
 */
interface KittyLsWindow {
  id?: unknown;
  neighbors?: Partial<Record<'left' | 'right' | 'top' | 'bottom', unknown[]>>;
}

/**
 * Picks the window beside `id` in the same tab. Kitty can keep ids of closed windows in
 * `neighbors`, so a neighbor counts only if it is still a window in this tab.
 */
export function pickTabNeighbor(windows: KittyLsWindow[], id: number): number | undefined {
  const me = windows.find((w) => w.id === id);
  if (!me) return undefined;
  const live = new Set(windows.map((w) => w.id).filter((w): w is number => Number.isInteger(w) && w !== id));
  const n = me.neighbors ?? {};
  const listed = [...(n.left ?? []), ...(n.right ?? []), ...(n.top ?? []), ...(n.bottom ?? [])];
  const neighbor = listed.find((w): w is number => typeof w === 'number' && live.has(w));
  return neighbor ?? live.values().next().value;
}

export async function findKittyNeighborWindowId(
  myKittyWindowId: string | number,
  options: { endpoint?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): Promise<string | undefined> {
  const numId = typeof myKittyWindowId === 'number' ? myKittyWindowId : parseInt(String(myKittyWindowId), 10);
  if (!Number.isInteger(numId) || numId <= 0) return undefined;

  try {
    const ctx = await resolveKittyContext({
      endpoint: options.endpoint,
      env: options.env,
      timeoutMs: options.timeoutMs ?? 40,
    });
    if (!ctx?.endpoint) return undefined;

    const { queryKittyWindows } = await import('./kitty');
    const osWindows = await queryKittyWindows({ endpoint: ctx.endpoint, env: options.env });

    for (const osWin of osWindows) {
      if (!Array.isArray(osWin?.tabs)) continue;
      for (const tab of osWin.tabs) {
        if (!Array.isArray(tab?.windows)) continue;
        const neighbor = pickTabNeighbor(tab.windows, numId);
        if (neighbor !== undefined) return String(neighbor);
      }
    }
  } catch {}

  return undefined;
}

