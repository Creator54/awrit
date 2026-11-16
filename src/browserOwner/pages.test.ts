import { expect, test } from 'bun:test';
import { PanePages } from './pages';

test('page switching and disposal cannot select sibling terminal pages', () => {
  const first = new PanePages<string>();
  const sibling = new PanePages<string>();
  first.add('one');
  sibling.add('sibling');
  expect(first.cycle()).toBeUndefined();
  first.add('two');
  expect(first.cycle()).toBe('one');
  expect(first.cycle()).toBe('two');
  expect(sibling.current).toBe('sibling');
  expect(first.clear()).toEqual(['one', 'two']);
  expect(first.current).toBeUndefined();
  expect(sibling.all()).toEqual(['sibling']);
});

const three = () => {
  const pages = new PanePages<string>();
  for (const p of ['a', 'b', 'c']) pages.add(p);
  return pages;
};

test('cycle goes both ways and wraps', () => {
  const pages = three();
  expect(pages.cycle()).toBe('a');
  expect(pages.cycle(-1)).toBe('c');
  expect(pages.cycle(-1)).toBe('b');
});

test('select jumps to a tab and ignores missing or current tabs', () => {
  const pages = three();
  expect(pages.select(0)).toBe('a');
  expect(pages.select(0)).toBeUndefined();
  expect(pages.select(7)).toBeUndefined();
  expect(pages.current).toBe('a');
});

test('closeCurrent shows the neighbour and ends empty', () => {
  const pages = three();
  pages.select(1);
  expect(pages.closeCurrent()).toEqual({ closed: 'b', next: 'c' });
  expect(pages.closeCurrent()).toEqual({ closed: 'c', next: 'a' });
  expect(pages.closeCurrent()).toEqual({ closed: 'a', next: undefined });
  expect(pages.closeCurrent()).toBeUndefined();
});

test('closeAt removes the page at the given index', () => {
  const pages = three();
  // close a non-current page — current stays the same
  expect(pages.closeAt(0)).toEqual({ closed: 'a', next: 'c' });
  expect(pages.current).toBe('c');
  expect(pages.all()).toEqual(['b', 'c']);
  // close the current page — neighbour becomes current
  const result = pages.closeAt(1);
  expect(result?.closed).toBe('c');
  expect(pages.current).toBe('b');
  // out of bounds returns undefined
  expect(pages.closeAt(5)).toBeUndefined();
});
