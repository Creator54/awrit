import type { WebContents } from 'electron';

export interface WaitResult {
  ok: boolean;
  error?: string;
}

// Stays under the tool's 10 s dispatcher timeout so a wait fails with its own message.
const MAX_SLEEP_MS = 8000;
const DEFAULT_ELEMENT_WAIT_MS = 5000;

/** Sleeps for `ms`, or polls for `selector` to become visible/hidden for up to `timeoutMs`. */
export async function performWait(
  wc: WebContents,
  options: { selector?: string; visible?: boolean; ms?: number; timeoutMs?: number }
): Promise<WaitResult> {
  const { selector, visible, ms, timeoutMs } = options;

  if (!selector && !ms) {
    return { ok: false, error: 'Must provide selector or ms' };
  }

  // If only ms provided, sleep
  if (!selector && ms) {
    if (ms < 0 || ms > MAX_SLEEP_MS) {
      return { ok: false, error: `ms must be between 0 and ${MAX_SLEEP_MS}` };
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { ok: true };
  }

  const code = `
(() => {
  const selector = ${JSON.stringify(selector)};
  const visible = ${visible ?? true};
  const maxWait = ${Math.min(Math.max(timeoutMs ?? DEFAULT_ELEMENT_WAIT_MS, 0), MAX_SLEEP_MS)};
  const startTime = Date.now();

  return new Promise((resolve) => {
    const checkElement = () => {
      try {
        const el = document.querySelector(selector);
        const isVisible = el && el.offsetParent !== null;
        const found = visible ? isVisible : !isVisible;

        if (found) {
          resolve({ ok: true });
          return;
        }

        if (Date.now() - startTime > maxWait) {
          resolve({ ok: false, error: 'Wait timeout' });
          return;
        }

        setTimeout(checkElement, 100);
      } catch (e) {
        resolve({ ok: false, error: String(e) });
      }
    };

    checkElement();
  });
})();
  `;

  try {
    const result = await wc.executeJavaScript(code, true);
    if (result && typeof result === 'object') {
      return result as WaitResult;
    }
  } catch (err) {
    return { ok: false, error: `Execution failed: ${String(err)}` };
  }

  return { ok: false, error: 'Unknown error' };
}
