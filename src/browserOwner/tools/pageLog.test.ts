import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import {
  MAX_LOG_ENTRIES,
  consoleEntries,
  networkEntries,
  pageStatus,
  startPageRecording,
} from './pageLog';

type Listener = (details: unknown, callback?: (response: unknown) => void) => void;

const fakeSession = () => {
  const registrations: string[] = [];
  const handlers = new Map<string, Listener>();
  const add = (event: string) => (listener: Listener) => {
    registrations.push(event);
    handlers.set(event, listener);
  };
  return {
    registrations,
    handlers,
    webRequest: {
      onBeforeRequest: add('onBeforeRequest'),
      onCompleted: add('onCompleted'),
      onErrorOccurred: add('onErrorOccurred'),
    },
  };
};

type FakeSession = ReturnType<typeof fakeSession>;

const fakePage = (id: number, session: FakeSession = fakeSession()) => {
  const wc = Object.assign(new EventEmitter(), { id, session });
  startPageRecording(wc as never);
  return { wc, session };
};

const consoleMessage = (message: string) => ({
  message,
  level: 'info' as const,
  lineNumber: 1,
  sourceId: '',
});

const request = (id: number, webContentsId: number, url = 'https://example.com/app.js') => ({
  id,
  url,
  method: 'GET',
  webContentsId,
  resourceType: 'script' as const,
});

test('console buffer keeps the newest entries up to the cap', () => {
  const { wc } = fakePage(101);
  for (let i = 0; i < MAX_LOG_ENTRIES + 50; i++) {
    wc.emit('console-message', consoleMessage(`message ${i}`));
  }
  const entries = consoleEntries(101);
  expect(entries).toHaveLength(MAX_LOG_ENTRIES);
  expect(entries[0].text).toBe('message 50');
  expect(entries.at(-1)?.text).toBe(`message ${MAX_LOG_ENTRIES + 49}`);
});

test('console records crashes, preload failures and failed loads but not aborted ones', () => {
  const { wc } = fakePage(102);
  wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com/old', true);
  expect(consoleEntries(102)).toHaveLength(0);

  wc.emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://missing.invalid/', true);
  wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 139 });
  wc.emit('preload-error', {}, '/app/preload.js', new Error('boom'));
  expect(consoleEntries(102).map((entry) => [entry.level, entry.text])).toEqual([
    ['error', 'load failed: ERR_NAME_NOT_RESOLVED (-105)'],
    ['error', 'renderer gone: crashed (exit 139)'],
    ['error', 'preload failed: boom'],
  ]);
  expect(pageStatus(102).crashReason).toBe('crashed');
});

test('navigation marks the buffer and records the document status', () => {
  const { wc } = fakePage(103);
  wc.emit('console-message', consoleMessage('before navigation'));
  wc.emit('did-navigate', {}, 'https://example.com/two', 200);
  wc.emit('console-message', consoleMessage('after navigation'));

  const texts = consoleEntries(103).map((entry) => entry.text);
  expect(texts).toContain('— navigated to https://example.com/two');
  expect(texts.at(-1)).toBe('after navigation');
  expect(pageStatus(103).httpStatus).toBe(200);

  // A file: or about: page has no HTTP status; do not keep the previous one.
  wc.emit('did-navigate', {}, 'about:blank', -1);
  expect(pageStatus(103).httpStatus).toBeUndefined();
});

test('network entries are per webContents even when the session is shared', () => {
  const session = fakeSession();
  const first = fakePage(104, session);
  const second = fakePage(105, session);

  const before = session.handlers.get('onBeforeRequest');
  const completed = session.handlers.get('onCompleted');
  const called: unknown[] = [];
  before?.(request(1, 104), (response) => called.push(response));
  before?.(request(2, 105, 'https://example.com/other.js'), () => undefined);
  completed?.({ ...request(1, 104), statusCode: 404, fromCache: false, timestamp: 0 });

  // Recording must never hold or cancel the request.
  expect(called).toEqual([{}]);
  expect(networkEntries(104)).toMatchObject([
    { method: 'GET', url: 'https://example.com/app.js', resourceType: 'script', status: 404 },
  ]);
  expect(networkEntries(105).map((entry) => entry.url)).toEqual(['https://example.com/other.js']);
  expect(networkEntries(104)[0].fromCache).toBe(false);
  expect(first.wc).not.toBe(second.wc);
});

test('one webRequest listener per session supplies every page', () => {
  const session = fakeSession();
  fakePage(106, session);
  fakePage(107, session);
  expect(session.registrations).toEqual(['onBeforeRequest', 'onCompleted', 'onErrorOccurred']);
});

test('network errors land on the matching entry', () => {
  const { session } = fakePage(108);
  session.handlers.get('onBeforeRequest')?.(request(7, 108), () => undefined);
  session.handlers.get('onErrorOccurred')?.({ ...request(7, 108), error: 'net::ERR_FAILED' });
  expect(networkEntries(108)).toMatchObject([{ error: 'net::ERR_FAILED' }]);
});

test('destroyed pages drop their buffers', () => {
  const { wc } = fakePage(109);
  wc.emit('console-message', consoleMessage('gone soon'));
  wc.emit('destroyed');
  expect(consoleEntries(109)).toEqual([]);
  expect(networkEntries(109)).toEqual([]);
  expect(pageStatus(109)).toEqual({});
});
