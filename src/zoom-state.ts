import fs from 'node:fs';
import path from 'node:path';
import { getAppDataPath } from './paths';
import { console_ } from './console';

type ZoomState = Record<string, number>;

const zoomMap = new Map<string, number>();

const ZOOM_STATE_FILE = path.join(getAppDataPath(), 'zoom-state.json');

/**
 * Loads zoom state from disk into memory.
 * Silently handles missing files (new users).
 */
export async function loadZoomState(): Promise<void> {
  try {
    const data = await fs.promises.readFile(ZOOM_STATE_FILE, 'utf-8');
    const state: ZoomState = JSON.parse(data);
    for (const [origin, factor] of Object.entries(state)) {
      zoomMap.set(origin, factor);
    }
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console_.error('[zoom-state] failed to load:', err);
    }
  }
}

/**
 * Returns the cached zoom factor for an origin, or 1.0 as default.
 * Falls back to reading the JSON file directly so the cache doesn't need
 * to be populated at startup — config.js writes directly to the file.
 */
export function getZoomFactor(origin: string): number {
  const cached = zoomMap.get(origin);
  if (cached !== undefined) return cached;
  // Fallback: read directly from JSON file if cache miss
  try {
    const data = fs.readFileSync(ZOOM_STATE_FILE, 'utf-8');
    const state: ZoomState = JSON.parse(data);
    return state[origin] ?? 1.0;
  } catch {
    return 1.0;
  }
}

/**
 * Updates the in-memory zoom factor for an origin.
 */
export function setZoomFactor(origin: string, factor: number): void {
  zoomMap.set(origin, factor);
}

/**
 * Persists the current zoom map to disk.
 * Errors are swallowed to avoid crashing the app on write failure.
 */
export async function saveZoomState(): Promise<void> {
  try {
    const state: ZoomState = Object.fromEntries(zoomMap);
    await fs.promises.writeFile(ZOOM_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
  } catch (err) {
    console_.error('[zoom-state] failed to save:', err);
  }
}
