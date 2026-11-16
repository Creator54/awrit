import type { WebContents } from 'electron';
import { showActionPreview } from './preview';

export interface ScrollResult {
  ok: boolean;
  error?: string;
  position?: { x: number; y: number };
}

export interface ScrollOptions {
  selector?: string;
  x?: number;
  y?: number;
  direction?: string;
  /** How long the cursor holds on the target before scrolling. Defaults to 400 ms. */
  previewMs?: number;
}

/** Centre of the element being scrolled, or of the window when scrolling the page. */
function scrollAnchorCode(selector: string | undefined): string {
  return `(() => {
  let el = null;
  ${selector ? `try { el = document.querySelector(${JSON.stringify(selector)}); } catch (e) {}` : ''}
  if (${JSON.stringify(Boolean(selector))} && !el) return null;
  const r = el ? el.getBoundingClientRect() : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})();`;
}

export async function performScroll(wc: WebContents, options: ScrollOptions): Promise<ScrollResult> {
  const { selector, x, y, direction, previewMs = 120 } = options;

  // Validate inputs
  if (!selector && x === undefined && y === undefined && !direction) {
    return { ok: false, error: 'Must provide selector, x/y coordinates, or direction' };
  }

  try {
    const anchor = (await wc.executeJavaScript(scrollAnchorCode(selector), true)) as { x?: number; y?: number } | null;
    if (typeof anchor?.x === 'number' && typeof anchor.y === 'number') {
      await showActionPreview(wc, { x: anchor.x, y: anchor.y, label: direction ? `scroll ${direction}` : 'scroll' }, previewMs);
    }
  } catch {
    // Scrolling without a preview is still correct.
  }

  const code = `
(() => {
  let target = window;
  let element = null;

  ${selector ? `try {
    element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return { ok: false, error: 'Element not found' };
    target = element;
  } catch (e) {
    return { ok: false, error: 'Invalid selector' };
  }` : ''}

  try {
    ${
      direction
        ? `const dir = ${JSON.stringify(direction)}.toLowerCase();
    if (dir === 'up') {
      target.scrollBy({ top: -window.innerHeight / 2, behavior: 'instant' });
    } else if (dir === 'down') {
      target.scrollBy({ top: window.innerHeight / 2, behavior: 'instant' });
    } else if (dir === 'left') {
      target.scrollBy({ left: -window.innerWidth / 2, behavior: 'instant' });
    } else if (dir === 'right') {
      target.scrollBy({ left: window.innerWidth / 2, behavior: 'instant' });
    } else {
      return { ok: false, error: 'Invalid direction (up/down/left/right)' };
    }`
        : `if (${x} !== undefined && ${y} !== undefined) {
      target.scrollTo({ left: ${x}, top: ${y}, behavior: 'instant' });
    } else if (${x} !== undefined) {
      target.scrollTo({ left: ${x}, behavior: 'instant' });
    } else if (${y} !== undefined) {
      target.scrollTo({ top: ${y}, behavior: 'instant' });
    }`
    }

    // Get final scroll position
    const scrollX = target === window ? window.scrollX : element?.scrollLeft ?? 0;
    const scrollY = target === window ? window.scrollY : element?.scrollTop ?? 0;

    return {
      ok: true,
      position: { x: scrollX, y: scrollY },
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
})();
  `;

  try {
    const result = await wc.executeJavaScript(code, true);
    if (result && typeof result === 'object') {
      return result as ScrollResult;
    }
  } catch (err) {
    return { ok: false, error: `Execution failed: ${String(err)}` };
  }

  return { ok: false, error: 'Unknown error' };
}
