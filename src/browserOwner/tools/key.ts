import type { WebContents } from 'electron';
import { changeSince, readPageState, type PageChange } from './change';
import { markAgentActivity } from './preview';

export interface KeyResult extends PageChange {
  ok: boolean;
  error?: string;
}

type Modifier = 'alt' | 'control' | 'meta' | 'shift';

export interface KeyOptions {
  key?: string;
  /** Keys pressed one after another, each with the same modifiers. */
  keys?: string[];
  modifiers?: Modifier[];
}

const MODIFIERS = new Set(['alt', 'control', 'meta', 'shift']);
export const MAX_KEYS = 40;
/** Apps that poll input once per frame (canvas, WebAssembly) can miss keys sent back to back. */
const KEY_GAP_MS = 30;

/** Sends one trusted key press. Throws if the page is gone. */
export function pressKey(wc: WebContents, key: string, modifiers: Modifier[] = []): void {
  const keyCode = key === ' ' ? 'Space' : key;
  wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
  // Chromium inserts text and submits forms from the char event, so printable keys and
  // Enter (as "\r") need one; Ctrl/Alt/Meta combinations are shortcuts and do not.
  const char = key === 'Enter' ? '\r' : key === 'Space' ? ' ' : key;
  if ([...char].length === 1 && !modifiers.includes('control') && !modifiers.includes('alt') && !modifiers.includes('meta')) {
    wc.sendInputEvent({ type: 'char', keyCode: char, modifiers });
  }
  wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
}

export async function performKey(wc: WebContents, options: KeyOptions): Promise<KeyResult> {
  if (!options || typeof options !== 'object') {
    return { ok: false, error: 'Key is required' };
  }
  const { key, keys, modifiers = [] } = options;
  if (key !== undefined && keys !== undefined) return { ok: false, error: 'Use key or keys, not both' };
  const sequence = keys ?? [key];
  if (!Array.isArray(sequence) || sequence.length === 0 || sequence.some(k => !k || typeof k !== 'string')) {
    return { ok: false, error: 'Key is required' };
  }
  if (sequence.length > MAX_KEYS) return { ok: false, error: `At most ${MAX_KEYS} keys per call` };

  if (!Array.isArray(modifiers)) {
    return { ok: false, error: 'Modifiers must be an array' };
  }

  for (const mod of modifiers) {
    if (!MODIFIERS.has(mod)) {
      return { ok: false, error: `Invalid modifier: ${mod}` };
    }
  }

  markAgentActivity(wc);
  const before = readPageState(wc);
  try {
    for (const [index, k] of (sequence as string[]).entries()) {
      if (index > 0) await new Promise(resolve => setTimeout(resolve, KEY_GAP_MS));
      pressKey(wc, k, modifiers);
    }
  } catch (err) {
    return { ok: false, error: `Key press failed: ${String(err)}` };
  }

  return { ok: true, ...(await changeSince(wc, before)) };
}
