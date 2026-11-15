import type { WebContents } from 'electron';
import { markAgentActivity, showNavigatePreview } from './preview';

export interface NavigateResult {
  ok: boolean;
  error?: string;
  url?: string;
  title?: string;
  /** The page did not finish loading in time; run wait before reading it. */
  loading?: true;
}

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:', 'file:']);
// Leaves room under the tool's own 10 s limit.
const LOAD_WAIT_MS = 8000;

export async function performNavigate(
  wc: WebContents,
  options: { url: string },
  loadWaitMs = LOAD_WAIT_MS,
  previewMs = 450,
): Promise<NavigateResult> {
  const { url } = options;

  if (!url || typeof url !== 'string') {
    return { ok: false, error: 'URL is required and must be a string' };
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (_err) {
    return { ok: false, error: 'Invalid URL format' };
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return { ok: false, error: 'URL must start with http://, https:// or file://' };
  }

  markAgentActivity(wc);
  await showNavigatePreview(wc, parsed.href, previewMs);
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const slow = new Promise<'slow'>((resolve) => {
      timer = setTimeout(() => resolve('slow'), loadWaitMs);
    });
    let outcome: 'slow' | undefined;
    try {
      outcome = await Promise.race([wc.loadURL(url).then(() => undefined), slow]);
    } finally {
      clearTimeout(timer);
    }
    const result: NavigateResult = { ok: true, url: wc.getURL(), title: wc.getTitle() };
    return outcome === 'slow' ? { ...result, loading: true } : result;
  } catch (err) {
    // Electron appends the failed URL (sometimes a whole data: error page) after " loading '".
    const reason = (err instanceof Error ? err.message : String(err)).split(" loading '")[0];
    return { ok: false, error: `Navigation failed: ${reason}` };
  }
}
