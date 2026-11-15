import { expect, test } from 'bun:test';
import type { WebContents } from 'electron';
import { changeSince } from './change';

function page(state: { url: string; title: string }) {
  return { getURL: () => state.url, getTitle: () => state.title } as unknown as WebContents;
}

test('reports nothing when the page did not change', async () => {
  const wc = page({ url: 'http://a/', title: 'A' });
  expect(await changeSince(wc, { url: 'http://a/', title: 'A' }, 0)).toEqual({});
});

test('reports only what changed', async () => {
  const wc = page({ url: 'http://a/', title: 'B' });
  expect(await changeSince(wc, { url: 'http://a/', title: 'A' }, 0)).toEqual({ title: 'B' });
  const moved = page({ url: 'http://b/', title: 'A' });
  expect(await changeSince(moved, { url: 'http://a/', title: 'A' }, 0)).toEqual({ url: 'http://b/' });
});
