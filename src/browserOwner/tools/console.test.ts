import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readConsoleLog } from './console';
import { encodeToolResult } from './encode';
import { startPageRecording } from './pageLog';

const page = (id: number) => {
  const wc = Object.assign(new EventEmitter(), {
    id,
    session: { webRequest: { onBeforeRequest() {}, onCompleted() {}, onErrorOccurred() {} } },
  });
  startPageRecording(wc as never);
  return wc;
};

const message = (level: 'debug' | 'info' | 'warning' | 'error', text: string) => ({
  message: text,
  level,
  lineNumber: 3,
  sourceId: 'https://example.com/app.js',
});

test('console returns entries at or above the requested level', () => {
  const wc = page(201);
  wc.emit('console-message', message('debug', 'trace'));
  wc.emit('console-message', message('info', 'hello'));
  wc.emit('console-message', message('warning', 'careful'));
  wc.emit('console-message', message('error', 'broken'));

  expect(readConsoleLog(wc as never, { level: 'debug' }).entries.map((entry) => entry.text)).toEqual([
    'trace',
    'hello',
    'careful',
    'broken',
  ]);
  expect(readConsoleLog(wc as never, { level: 'warning' }).entries.map((entry) => entry.text)).toEqual([
    'careful',
    'broken',
  ]);
  expect(readConsoleLog(wc as never, {}).entries).toHaveLength(4);
});

test('console keeps source and clips long text', () => {
  const wc = page(202);
  wc.emit('console-message', message('error', 'x'.repeat(5000)));
  const [entry] = readConsoleLog(wc as never, {}).entries;
  expect(entry.source).toBe('https://example.com/app.js:3');
  expect(entry.text.length).toBe(2000);
  expect(entry.level).toBe('error');
  expect(typeof entry.time).toBe('string');
});

test('console returns the newest entries when limited', () => {
  const wc = page(203);
  for (let i = 0; i < 10; i++) wc.emit('console-message', message('info', `line ${i}`));
  expect(readConsoleLog(wc as never, { limit: 3 }).entries.map((entry) => entry.text)).toEqual([
    'line 7',
    'line 8',
    'line 9',
  ]);
});

test('console is empty for a page that never recorded', () => {
  expect(readConsoleLog({ id: 404404 }, {})).toEqual({ entries: [] });
});

test('console drops the oldest entries to fit the tool output limit', () => {
  const wc = page(299);
  for (let i = 0; i < 200; i++) wc.emit('console-message', message('error', `${i} ${'x'.repeat(1990)}`));

  const result = readConsoleLog(wc as never, { limit: 200 });
  expect(result.truncated).toBe(true);
  expect(result.entries.length).toBeGreaterThan(0);
  expect(result.entries.at(-1)?.text.startsWith('199 ')).toBe(true);
  expect(() => encodeToolResult(result)).not.toThrow();
});
