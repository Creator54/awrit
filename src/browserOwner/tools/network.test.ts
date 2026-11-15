import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readNetworkLog } from './network';
import { startPageRecording } from './pageLog';

const page = (id: number) => {
  const handlers = new Map<string, (details: Record<string, unknown>, callback?: (response: unknown) => void) => void>();
  const session = {
    webRequest: {
      onBeforeRequest: (
        listener: (details: Record<string, unknown>, callback?: (response: unknown) => void) => void,
      ) => handlers.set('request', listener),
      onCompleted(listener: (details: Record<string, unknown>) => void) {
        handlers.set('completed', listener);
      },
      onErrorOccurred(listener: (details: Record<string, unknown>) => void) {
        handlers.set('error', listener);
      },
    },
  };
  const wc = Object.assign(new EventEmitter(), { id, session });
  startPageRecording(wc as never);
  return { wc, handlers };
};

const details = (id: number, webContentsId: number, url: string, resourceType = 'script') => ({
  id,
  url,
  method: 'GET',
  webContentsId,
  resourceType,
});

const record = (
  page: ReturnType<typeof page>,
  id: number,
  url: string,
  result: { statusCode?: number; fromCache?: boolean; error?: string },
) => {
  page.handlers.get('request')?.(details(id, page.wc.id, url), () => undefined);
  if (result.error !== undefined) {
    page.handlers.get('error')?.({ ...details(id, page.wc.id, url), error: result.error });
  } else {
    page.handlers.get('completed')?.({
      ...details(id, page.wc.id, url),
      statusCode: result.statusCode ?? 200,
      fromCache: result.fromCache ?? false,
    });
  }
};

test('network filters failed requests only', () => {
  const current = page(301);
  record(current, 1, 'https://example.com/ok.js', { statusCode: 200 });
  record(current, 2, 'https://example.com/missing.js', { statusCode: 404 });
  record(current, 3, 'https://example.com/blocked.js', { error: 'net::ERR_BLOCKED_BY_CLIENT' });

  expect(readNetworkLog(current.wc as never, { failedOnly: true }).entries.map((entry) => entry.url)).toEqual([
    'https://example.com/missing.js',
    'https://example.com/blocked.js',
  ]);
  expect(readNetworkLog(current.wc as never, {}).entries).toHaveLength(3);
});

test('network filters by url substring, ignoring case', () => {
  const current = page(302);
  record(current, 1, 'https://example.com/API/users', {});
  record(current, 2, 'https://example.com/logo.png', {});

  const entries = readNetworkLog(current.wc as never, { urlContains: 'api/USERS' }).entries;
  expect(entries.map((entry) => entry.url)).toEqual(['https://example.com/API/users']);
});

test('network reports status, cache and duration, and limits the newest', () => {
  const current = page(303);
  record(current, 1, 'https://example.com/one.js', { statusCode: 304, fromCache: true });
  record(current, 2, 'https://example.com/two.js', {});

  const entries = readNetworkLog(current.wc as never, { limit: 1 }).entries;
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    method: 'GET',
    url: 'https://example.com/two.js',
    status: 200,
    resourceType: 'script',
    fromCache: false,
  });
  expect(typeof entries[0].durationMs).toBe('number');
  expect(readNetworkLog(current.wc as never, {}).entries[0].fromCache).toBe(true);
});

test('network is empty for an unknown page', () => {
  expect(readNetworkLog({ id: 405405 }, { failedOnly: true })).toEqual({ entries: [] });
});
