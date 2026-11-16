import { expect, test } from 'bun:test';
import { performScroll } from './scroll';

const createMockWebContents = (result: unknown) => ({
  executeJavaScript: async () => result,
});

test('scroll by direction (down)', async () => {
  const mockResult = { ok: true, position: { x: 0, y: 300 } };
  const wc = createMockWebContents(mockResult) as any;

  const result = await performScroll(wc, { direction: 'down' });
  expect(result.ok).toBe(true);
  expect(result.ok).toBe(true);
  expect(result.position?.y).toBe(300);
});

test('scroll by coordinates', async () => {
  const mockResult = { ok: true, position: { x: 100, y: 200 } };
  const wc = createMockWebContents(mockResult) as any;

  const result = await performScroll(wc, { x: 100, y: 200 });
  expect(result.ok).toBe(true);
  expect(result.position?.x).toBe(100);
  expect(result.position?.y).toBe(200);
});

test('scroll element by selector', async () => {
  const mockResult = { ok: true, position: { x: 0, y: 100 } };
  const wc = createMockWebContents(mockResult) as any;

  const result = await performScroll(wc, { selector: '.content', direction: 'down' });
  expect(result.ok).toBe(true);
  expect(result.ok).toBe(true);
});

test('scroll rejects missing parameters', async () => {
  const wc = createMockWebContents({}) as any;

  const result = await performScroll(wc, {});
  expect(result.ok).toBe(false);
  expect(result.error).toContain('Must provide');
});

test('scroll handles element not found', async () => {
  const mockResult = { ok: false, error: 'Element not found' };
  const wc = createMockWebContents(mockResult) as any;

  const result = await performScroll(wc, { selector: '.nonexistent', direction: 'down' });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('not found');
});

test('scroll rejects invalid direction', async () => {
  const mockResult = { ok: false, error: 'Invalid direction' };
  const wc = createMockWebContents(mockResult) as any;

  const result = await performScroll(wc, { direction: 'diagonal' });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('Invalid direction');
});

test('scroll handles execution error', async () => {
  const wc = {
    executeJavaScript: async () => {
      throw new Error('Script error');
    },
  } as any;

  const result = await performScroll(wc, { direction: 'down' });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('Execution failed');
});

test('scroll applies immediately so the reported position is the real one', async () => {
  const scripts: string[] = [];
  const wc = {
    executeJavaScript: async (code: string) => {
      scripts.push(code);
      return { ok: true, position: { x: 0, y: 0 } };
    },
  } as never;
  await performScroll(wc, { direction: 'down', previewMs: 0 });
  const scrollScript = scripts.find((c) => c.includes('scrollBy')) ?? '';
  expect(scrollScript).toContain("behavior: 'instant'");
  expect(scrollScript).not.toContain('smooth');
});

test('scroll moves the cursor to the area before moving, and leaves it to fade', async () => {
  const scripts: string[] = [];
  const wc = {
    executeJavaScript: async (code: string) => {
      scripts.push(code);
      if (code.includes('getBoundingClientRect')) return { x: 200, y: 150 };
      return { ok: true, position: { x: 0, y: 300 } };
    },
  } as never;
  const result = await performScroll(wc, { direction: 'down', previewMs: 1 });
  expect(result.ok).toBe(true);
  const draw = scripts.findIndex((c) => c.includes('__awrit_agent_overlay') && c.includes('<svg'));
  const scroll = scripts.findIndex((c) => c.includes('scrollBy'));
  expect(draw).toBeGreaterThanOrEqual(0);
  expect(draw).toBeLessThan(scroll);
  expect(scripts[draw]).toContain('scroll down');
  expect(scripts.some((c) => c.startsWith('document.getElementById'))).toBe(false);
});

test('scroll skips the cursor when the selector matches nothing', async () => {
  const scripts: string[] = [];
  const wc = {
    executeJavaScript: async (code: string) => {
      scripts.push(code);
      return code.includes('getBoundingClientRect') ? null : { ok: false, error: 'Element not found' };
    },
  } as never;
  const result = await performScroll(wc, { selector: '#nope', previewMs: 1 });
  expect(result.ok).toBe(false);
  expect(scripts.some((c) => c.includes('createElement'))).toBe(false);
});
