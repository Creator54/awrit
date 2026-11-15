import type { WebContents } from 'electron';
import { showActionPreview, showAreaPreview, type PreviewRect } from './preview';
import { focusAccessibilityRef } from './accessibility';
import { MAX_KEYS, performKey } from './key';

export interface TypeResult {
  ok: boolean;
  error?: string;
  /** The field's text after typing (cut to 200 characters; never reported for password fields). */
  value?: string;
}

export interface TypeOptions {
  text: string;
  selector?: string;
  ref?: string;
  /** How long the cursor holds on the field before typing. Defaults to 400 ms. */
  previewMs?: number;
}

interface Target {
  ok: boolean;
  error?: string;
  x?: number;
  y?: number;
  rect?: PreviewRect;
  secret?: boolean;
  /** Focus is on no text field (a canvas app, say): send the text as key presses. */
  keys?: boolean;
}

/** Validates the field, focuses it, selects its current text, and returns its centre. */
function prepareFieldCode(selector: string | undefined): string {
  return `
(() => {
  let element = null;
  ${
    selector
      ? `try {
    element = document.querySelector(${JSON.stringify(selector)});
  } catch (e) {
    return { ok: false, error: 'Invalid selector' };
  }
  if (!element) return { ok: false, error: 'Element not found' };`
      : `element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  const focusedTag = element?.tagName.toUpperCase();
  if (focusedTag !== 'INPUT' && focusedTag !== 'TEXTAREA') return { ok: false, keys: true };`
  }
  const tag = element.tagName.toUpperCase();
  if (tag !== 'INPUT' && tag !== 'TEXTAREA') return { ok: false, error: 'Element is not an input or textarea' };
  if (element.readOnly || element.disabled) return { ok: false, error: 'Element is disabled or read-only' };
  element.scrollIntoView({ block: 'center', inline: 'center' });
  element.focus();
  // Selecting the old text makes the typed text replace it.
  element.select();
  const rect = element.getBoundingClientRect();
  return {
    ok: true,
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    secret: element.type === 'password',
    rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
  };
})();`;
}

/** What the cursor chip shows of the typed text; passwords are never echoed. */
function typedPreview(text: string, secret?: boolean): string {
  if (secret) return '••••';
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > 20 ? `${flat.slice(0, 20)}…` : flat;
}

export async function performType(wc: WebContents, options: TypeOptions): Promise<TypeResult> {
  const { text, selector, ref, previewMs = 120 } = options;
  if (ref && selector !== undefined) return { ok: false, error: 'Use ref or selector, not both' };

  if (!text) {
    return { ok: false, error: 'Text is required' };
  }

  let target: Target;
  try {
    if (ref) await focusAccessibilityRef(wc, ref);
    target = (await wc.executeJavaScript(prepareFieldCode(selector), true)) as Target;
  } catch (err) {
    return { ok: false, error: `Execution failed: ${String(err)}` };
  }
  if (target?.keys && ref) return { ok: false, error: 'Element is not an input or textarea' };
  if (target?.keys) {
    const keys = [...text].map(c => (c === '\n' ? 'Enter' : c));
    if (keys.length > MAX_KEYS) return { ok: false, error: `No text field is focused; at most ${MAX_KEYS} characters can be sent as key presses` };
    const result = await performKey(wc, { keys });
    return result.ok ? { ok: true } : { ok: false, error: result.error };
  }
  if (!target?.ok || target.x === undefined || target.y === undefined) {
    return { ok: false, error: target?.error ?? 'Unknown error' };
  }

  // The cursor chip already says type; the field box stays quiet.
  if (target.rect) void showAreaPreview(wc, target.rect);
  await showActionPreview(wc, { x: target.x, y: target.y, label: `type "${typedPreview(text, target.secret)}"` }, previewMs);

  // Revalidate refs after the preview before inserting into the focused field.
  if (ref) {
    try { await focusAccessibilityRef(wc, ref); }
    catch (error) { return { ok: false, error: String(error) }; }
  }

  // insertText goes through the browser's text-input path, so the page sees trusted
  // beforeinput/input events and frameworks update their state.
  try {
    await wc.insertText(text);
  } catch (err) {
    return { ok: false, error: `Typing failed: ${String(err)}` };
  }
  return { ok: true, ...(await readFieldValue(wc)) };
}

async function readFieldValue(wc: WebContents): Promise<{ value?: string }> {
  try {
    const value = await wc.executeJavaScript(
      `(() => { let el = document.activeElement; while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement; return el && 'value' in el && el.type !== 'password' ? String(el.value).slice(0, 200) : undefined; })();`,
      true,
    );
    return typeof value === 'string' ? { value } : {};
  } catch {
    return {};
  }
}
