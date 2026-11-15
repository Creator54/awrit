import { expect, test } from 'bun:test';
import { readPageState } from './page';

const page = (overrides: Record<string, unknown> = {}) =>
  ({
    id: 501,
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
    isLoading: () => false,
    getZoomFactor: () => 1.25,
    isCrashed: () => false,
    navigationHistory: { canGoBack: () => true, canGoForward: () => false },
    executeJavaScript: async () => ({ width: 1280, height: 720, devicePixelRatio: 2 }),
    ...overrides,
  }) as never;

test('page reports url, title, loading, viewport, zoom and history', async () => {
  const state = await readPageState(page());
  expect(state).toEqual({
    url: 'https://example.com/',
    title: 'Example',
    loading: false,
    zoom: 1.25,
    viewport: { width: 1280, height: 720 },
    devicePixelRatio: 2,
    canGoBack: true,
    canGoForward: false,
    crashed: false,
  });
});

test('page still reports state when the page cannot be measured', async () => {
  const state = await readPageState(
    page({
      executeJavaScript: async () => {
        throw new Error('page closed');
      },
    }),
  );
  expect(state.url).toBe('https://example.com/');
  expect(state.viewport).toBeUndefined();
});

test('page clips a very long title', async () => {
  const state = await readPageState(page({ getTitle: () => 't'.repeat(4000) }));
  expect(state.title.length).toBe(2000);
});
