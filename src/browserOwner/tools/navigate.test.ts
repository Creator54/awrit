import { expect, test } from 'bun:test';
import type { WebContents } from 'electron';
import { performNavigate } from './navigate';

function page(onLoad: (url: string) => Promise<void> = async () => undefined) {
  const state = { url: 'https://example.com/', title: 'Example' };
  const loaded: string[] = [];
  const wc = {
    loadURL: async (url: string) => {
      loaded.push(url);
      await onLoad(url);
      state.url = url;
      state.title = 'Loaded';
    },
    getURL: () => state.url,
    getTitle: () => state.title,
  } as unknown as WebContents;
  return { wc, loaded };
}

test('navigate loads the page and reports where it ended up', async () => {
  const { wc, loaded } = page();
  expect(await performNavigate(wc, { url: 'https://google.com/' })).toEqual({
    ok: true,
    url: 'https://google.com/',
    title: 'Loaded',
  });
  expect(loaded).toEqual(['https://google.com/']);
});

test('navigate says when the page is still loading instead of claiming it loaded', async () => {
  const { wc } = page(() => new Promise(() => {}));
  expect(await performNavigate(wc, { url: 'https://slow.test/' }, 10)).toEqual({
    ok: true,
    url: 'https://example.com/',
    title: 'Example',
    loading: true,
  });
});

test('navigate accepts http, https and file URLs', async () => {
  for (const url of ['http://localhost:3000/', 'https://a.test/', 'file:///tmp/a.html']) {
    expect((await performNavigate(page().wc, { url })).ok).toBe(true);
  }
});

test('navigate rejects other schemes without loading them', async () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'chrome://gpu', 'ftp://a.test/']) {
    const { wc, loaded } = page();
    const result = await performNavigate(wc, { url });
    expect(result.ok).toBe(false);
    expect(result.error).toContain('http://');
    expect(loaded).toEqual([]);
  }
});

test('navigate rejects relative, empty and non-string URLs', async () => {
  expect((await performNavigate(page().wc, { url: '/page' })).error).toContain('Invalid URL');
  expect((await performNavigate(page().wc, { url: '' })).error).toContain('required');
  expect((await performNavigate(page().wc, { url: null as unknown as string })).error).toContain('required');
});

test('navigate reports a failed load', async () => {
  const { wc } = page(async () => {
    throw new Error('ERR_NAME_NOT_RESOLVED');
  });
  const result = await performNavigate(wc, { url: 'https://nope.invalid/' });
  expect(result.ok).toBe(false);
  expect(result.error).toContain('ERR_NAME_NOT_RESOLVED');
});

test('navigate keeps the error short when Electron appends the failed URL', async () => {
  const { wc } = page(async () => {
    throw new Error(`ERR_ABORTED (-3) loading 'data:text/html,${'x'.repeat(5000)}'`);
  });
  const result = await performNavigate(wc, { url: 'https://nope.invalid/' });
  expect(result.error).toBe('Navigation failed: ERR_ABORTED (-3)');
});
