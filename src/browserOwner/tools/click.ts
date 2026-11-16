import type { WebContents } from 'electron';
import { changeSince, readPageState, type PageChange } from './change';
import { elementLabelCode, showActionPreview, showAreaPreview } from './preview';
import { resolveAccessibilityRef } from './accessibility';

export interface ClickResult extends PageChange {
  ok: boolean;
  error?: string;
}

export interface ClickOptions {
  selector?: string;
  ref?: string;
  x?: number;
  y?: number;
  /** How long the cursor holds on the target before the click. Defaults to 400 ms. */
  previewMs?: number;
}

interface Target {
  ok: boolean;
  error?: string;
  x?: number;
  y?: number;
  rect?: { x: number; y: number; width: number; height: number };
  label?: string;
}

/** Finds the click point in page coordinates and scrolls the target into view. */
function resolveTargetCode(options: ClickOptions): string {
  const { selector, x, y } = options;
  return `
(() => {
  let x, y;
  ${
    selector
      ? `let el;
  try { el = document.querySelector(${JSON.stringify(selector)}); } catch (e) { return { ok: false, error: 'Invalid selector' }; }
  if (!el) return { ok: false, error: 'Element not found' };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return { ok: false, error: 'Element is not visible (zero size)' };
  x = rect.left + rect.width / 2;
  y = rect.top + rect.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (!hit || (hit !== el && !el.contains(hit) && !hit.contains(el))) {
    return { ok: false, error: 'Element is covered by another element' };
  }`
      : `x = ${Number(x)}; y = ${Number(y)};
  const hit = document.elementFromPoint(x, y);
  if (!hit) return { ok: false, error: 'No element at coordinates' };
  const rect = hit.getBoundingClientRect();`
  }
  return { ok: true, x, y, label: ${elementLabelCode('(typeof el !== \'undefined\' ? el : hit)')}, rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height } };
})();`;
}

export async function performClick(wc: WebContents, options: ClickOptions): Promise<ClickResult> {
  const { selector, ref, x, y, previewMs = 120 } = options;

  if (ref && (selector !== undefined || x !== undefined || y !== undefined)) {
    return { ok: false, error: 'Use ref, selector, or coordinates, not multiple targets' };
  }
  if (!ref && !selector && (x === undefined || y === undefined)) {
    return { ok: false, error: 'Must provide either selector or x,y coordinates' };
  }

  let target: Target;
  try {
    target = ref
      ? { ok: true, ...(await resolveAccessibilityRef(wc, ref)) }
      : (await wc.executeJavaScript(resolveTargetCode(options), true)) as Target;
  } catch (err) {
    return { ok: false, error: `Execution failed: ${String(err)}` };
  }
  if (!target?.ok || target.x === undefined || target.y === undefined) {
    return { ok: false, error: target?.error ?? 'Unknown error' };
  }

  // The cursor chip already says click; the box itself stays quiet.
  if (target.rect) void showAreaPreview(wc, target.rect);
  await showActionPreview(wc, { x: target.x, y: target.y, label: target.label ? `click "${target.label}"` : 'click', press: true }, previewMs);

  // The preview awaits page work: a ref must still belong to the current document.
  if (ref) {
    try { target = { ok: true, ...(await resolveAccessibilityRef(wc, ref)) }; }
    catch (error) { return { ok: false, error: String(error) }; }
  }

  if (target.x === undefined || target.y === undefined) return { ok: false, error: 'Target has no coordinates' };

  // sendInputEvent takes view coordinates, so page zoom has to be applied.
  const zoom = typeof wc.getZoomFactor === 'function' ? wc.getZoomFactor() : 1;
  const point = { x: Math.round(target.x * zoom), y: Math.round(target.y * zoom) };
  const before = readPageState(wc);
  wc.sendInputEvent({ type: 'mouseMove', ...point });
  wc.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
  wc.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
  return { ok: true, ...(await changeSince(wc, before)) };
}
