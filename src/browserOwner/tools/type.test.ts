import { expect, test } from 'bun:test';
import type { WebContents } from 'electron';
import { runInNewContext } from 'node:vm';
import { performType } from './type';

function fakePage(target: unknown) {
  const scripts: string[] = [];
  const inserted: string[] = [];
  const wc = {
    executeJavaScript: async (code: string) => {
      scripts.push(code);
      if (scripts.length === 1) return target;
      return code.includes('activeElement') ? 'hi there' : undefined;
    },
    insertText: async (text: string) => {
      inserted.push(text);
    },
  } as unknown as WebContents;
  return { wc, scripts, inserted };
}

test('type focuses and selects the field, then inserts text through the browser', async () => {
  const { wc, scripts, inserted } = fakePage({ ok: true, x: 1, y: 2 });
  expect(await performType(wc, { text: 'hello', selector: '#name', previewMs: 0 })).toEqual({ ok: true, value: 'hi there' });
  expect(scripts[0]).toContain('#name');
  expect(scripts[0]).toContain('element.focus()');
  expect(scripts[0]).toContain('element.select()');
  expect(inserted).toEqual(['hello']);
});

test('type without selector uses the focused element', async () => {
  const { wc, scripts } = fakePage({ ok: true, x: 1, y: 2 });
  await performType(wc, { text: 'world', previewMs: 0 });
  expect(scripts[0]).toContain('document.activeElement');
});

test('type shows the field before typing and leaves the cursor to fade', async () => {
  const { wc, scripts, inserted } = fakePage({ ok: true, x: 1, y: 2, rect: { x: 0, y: 0, width: 10, height: 20 } });
  const pending = performType(wc, { text: 'a', selector: '#q', previewMs: 30 });
  await new Promise((r) => setTimeout(r, 10));
  const cursor = scripts.findIndex((c) => c.includes('<svg'));
  expect(cursor).toBeGreaterThanOrEqual(1);
  expect(scripts[cursor]).toContain('__awrit_agent_overlay');
  expect(inserted).toHaveLength(0);
  await pending;
  expect(scripts.some((c) => c.includes("getElementById('area')"))).toBe(true);
  expect(scripts.some((c) => c.includes('"typing"'))).toBe(false);
  expect(scripts.some((c) => c.startsWith('document.getElementById'))).toBe(false);
  expect(inserted).toEqual(['a']);
});

test('type does not insert text when the field is invalid', async () => {
  const { wc, inserted } = fakePage({ ok: false, error: 'Element is disabled or read-only' });
  const result = await performType(wc, { text: 'x', selector: '#q', previewMs: 0 });
  expect(result).toEqual({ ok: false, error: 'Element is disabled or read-only' });
  expect(inserted).toHaveLength(0);
});

test('type follows shadow focus and reads the same focused field', async () => {
  let selected = false;
  const input = { tagName: 'INPUT', type: 'text', value: 'old',
    scrollIntoView() {}, focus() {}, select() { selected = true; },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 20, height: 20 }),
  };
  const document = { activeElement: { shadowRoot: { activeElement: input } } };
  const wc = {
    executeJavaScript: async (code: string) => runInNewContext(code, { document }),
    insertText: async (text: string) => { expect(selected).toBe(true); input.value = text; },
  } as unknown as WebContents;
  expect(await performType(wc, { text: 'replacement', previewMs: 0 })).toEqual({ ok: true, value: 'replacement' });
  input.type = 'password';
  expect(await performType(wc, { text: 'secret', previewMs: 0 })).toEqual({ ok: true });
});

test('type rejects empty text', async () => {
  const { wc } = fakePage({});
  expect((await performType(wc, { text: '', selector: 'input' })).ok).toBe(false);
});

test('type reports insert failures', async () => {
  const wc = {
    executeJavaScript: async () => ({ ok: true, x: 1, y: 2 }),
    insertText: async () => {
      throw new Error('detached');
    },
  } as unknown as WebContents;
  const result = await performType(wc, { text: 'x', selector: '#q', previewMs: 0 });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('detached');
});

test('type does not read back a password field', async () => {
  const { wc, scripts } = fakePage({ ok: true, x: 1, y: 1 });
  await performType(wc, { text: 'x', selector: '#pw', previewMs: 0 });
  const readBack = scripts.find((c) => c.includes('activeElement') && c.includes('.value'));
  expect(readBack).toContain("el.type !== 'password'");
});

test('type without a focused text field sends the text as key presses', async () => {
  const events: Array<{ type: string; keyCode: string }> = [];
  const wc = {
    executeJavaScript: async () => ({ ok: false, keys: true }),
    insertText: async () => { throw new Error('must not insert'); },
    sendInputEvent: (event: { type: string; keyCode: string }) => events.push(event),
  } as unknown as WebContents;
  expect(await performType(wc, { text: 'a b\n', previewMs: 0 })).toEqual({ ok: true });
  expect(events.filter(e => e.type === 'char').map(e => e.keyCode)).toEqual(['a', ' ', 'b', '\r']);
  expect(events.filter(e => e.type === 'keyDown').map(e => e.keyCode)).toEqual(['a', 'Space', 'b', 'Enter']);
});

test('type with a ref to a non-field still fails', async () => {
  const { wc, inserted } = fakePage({ ok: false, keys: true });
  const result = await performType(wc, { text: 'x', ref: 'w1s1:e0', previewMs: 0 });
  expect(result.ok).toBe(false);
  expect(inserted).toHaveLength(0);
});
