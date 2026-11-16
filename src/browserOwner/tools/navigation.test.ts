import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import type { DocumentId } from './dispatch';
import { createNavigationTracker } from './navigation';

function page(url: string) {
  const emitter = new EventEmitter();
  const wc = Object.assign(emitter, { url, getURL: () => wc.url }) as unknown as WebContents & { url: string };
  return wc;
}

test('document id is stable until the page navigates, then changes', () => {
  const left: DocumentId[] = [];
  const current = createNavigationTracker((d) => left.push(d));
  const wc = page('http://a.test/');

  const first = current(wc);
  expect(current(wc)).toEqual(first);

  wc.url = 'http://a.test/next';
  (wc as unknown as EventEmitter).emit('did-navigate');
  expect(left).toEqual([first]);

  const second = current(wc);
  expect(second.navId).toBe(first.navId + 1);
  expect(second.frameUrl).toBe('http://a.test/next');
});

test('navigating the same url again still gives a new document id', () => {
  const current = createNavigationTracker(() => undefined);
  const wc = page('http://a.test/');
  const first = current(wc);
  (wc as unknown as EventEmitter).emit('did-navigate');
  expect(current(wc)).not.toEqual(first);
});

test('pages are tracked independently', () => {
  const current = createNavigationTracker(() => undefined);
  const a = page('http://a.test/');
  const b = page('http://a.test/');
  current(a);
  (a as unknown as EventEmitter).emit('did-navigate');
  expect(current(a).navId).toBe(2);
  expect(current(b).navId).toBe(1);
});
