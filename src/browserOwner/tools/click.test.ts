import { expect, test } from 'bun:test';
import type { WebContents } from 'electron';
import { performClick } from './click';

function fakePage(target: unknown, zoom = 1) {
  const scripts: string[] = [];
  const inputs: Array<Record<string, unknown>> = [];
  const wc = {
    executeJavaScript: async (code: string) => {
      scripts.push(code);
      return scripts.length === 1 ? target : undefined;
    },
    sendInputEvent: (event: Record<string, unknown>) => inputs.push(event),
    getZoomFactor: () => zoom,
  } as unknown as WebContents;
  return { wc, scripts, inputs };
}

test('click sends a trusted mouse press at the element centre', async () => {
  const { wc, inputs } = fakePage({ ok: true, x: 100.4, y: 50 });
  expect(await performClick(wc, { selector: '#go', previewMs: 0 })).toEqual({ ok: true });
  expect(inputs.map((e) => e.type)).toEqual(['mouseMove', 'mouseDown', 'mouseUp']);
  expect(inputs[1]).toMatchObject({ x: 100, y: 50, button: 'left', clickCount: 1 });
});

test('click scales page coordinates by the zoom factor', async () => {
  const { wc, inputs } = fakePage({ ok: true, x: 100, y: 40 }, 1.5);
  await performClick(wc, { x: 100, y: 40, previewMs: 0 });
  expect(inputs[1]).toMatchObject({ x: 150, y: 60 });
});

test('click shows the cursor before pressing and leaves it to fade', async () => {
  const { wc, scripts, inputs } = fakePage({ ok: true, x: 10, y: 20 });
  const pending = performClick(wc, { selector: '#go', previewMs: 30 });
  await new Promise((r) => setTimeout(r, 10));
  const cursor = scripts.find((c) => c.includes('<svg'));
  expect(cursor).toContain('__awrit_agent_overlay');
  expect(cursor).toContain('pointer-events: none');
  expect(inputs).toHaveLength(0);
  await pending;
  expect(scripts.some((c) => c.startsWith('document.getElementById'))).toBe(false);
  expect(inputs).toHaveLength(3);
});

test('click does nothing when the target cannot be found or is covered', async () => {
  for (const error of ['Element not found', 'Element is covered by another element']) {
    const { wc, inputs } = fakePage({ ok: false, error });
    expect(await performClick(wc, { selector: '#x', previewMs: 0 })).toEqual({ ok: false, error });
    expect(inputs).toHaveLength(0);
  }
});

test('click requires a selector or coordinates', async () => {
  const { wc } = fakePage({});
  const result = await performClick(wc, {});
  expect(result.ok).toBe(false);
  expect(result.error).toContain('Must provide either');
});

test('click reports script failures', async () => {
  const wc = {
    executeJavaScript: async () => {
      throw new Error('page gone');
    },
  } as unknown as WebContents;
  const result = await performClick(wc, { selector: '#x' });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('page gone');
});
