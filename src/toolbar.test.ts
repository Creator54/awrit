import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { LOOPBACK_ADDRESS } from './loopback';

test('omnibox keeps Delete for editing and Shift+Delete for history', () => {
  const source = readFileSync(new URL('./toolbar/src/Toolbar.tsx', import.meta.url), 'utf8');
  const block = source.slice(
    source.indexOf('  const getUrlOrSearch ='),
    source.indexOf('  // Keep keyboard selection'),
  );
  let history = [{ title: 'Example', url: 'https://example.com/', isSearch: false }];
  const effects: Array<() => void> = [];
  let input = '';
  let tabs: Array<{ title: string; url: string; current: boolean }> = [];
  let selected = 0;
  let navigated = '';
  let refreshed = false;
  const context = vm.createContext({
    LOOPBACK_ADDRESS,
    url: () => input,
    lastCommittedUrl: () => 'https://current.com/',
    history: () => history,
    openTabs: () => tabs,
    selectedIndex: () => selected,
    setSelectedIndex: (update: (value: number) => number) => {
      selected = update(selected);
    },
    setHistory: (update: (value: typeof history) => typeof history) => {
      history = update(history);
    },
    createMemo: (read: () => unknown) => read,
    createEffect: (effect: () => void) => {
      effects.push(effect);
      effect();
    },
    localStorage: { setItem() {} },
    window: {
      ipc: {
        navigateTo: (url: string) => {
          navigated = url;
        },
        refresh: () => {
          refreshed = true;
        },
        openInNewWindow: (url: string) => {
          navigated = url;
        },
        toggleUrlBar() {},
      },
    },
  });
  vm.runInContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(block), context);
  let prevented = false;
  const key = (key: string, shiftKey = false, isComposing = false, ctrlKey = false) => {
    prevented = false;
    context.event = {
      key,
      shiftKey,
      isComposing,
      ctrlKey,
      preventDefault: () => {
        prevented = true;
      },
    };
    vm.runInContext('handleKeyDown(event)', context);
  };
  selected = -1;
  key('Enter');
  expect(navigated).toBe('');
  key('ArrowDown');
  expect(selected).toBe(0);
  selected = -1;
  key('ArrowUp');
  expect(selected).toBe(0);
  key('Delete');
  expect(history.length).toBe(1);
  expect(prevented).toBe(false);
  key('Enter', false, true);
  expect(navigated).toBe('');
  key('Delete', true);
  expect(history.length).toBe(0);
  expect(prevented).toBe(true);
  // With history empty there is nothing left to select.
  key('ArrowDown');
  expect(selected).toBe(-1);
  selected = 1;
  history = [
    { title: 'First', url: 'https://first.com/', isSearch: false },
    { title: 'Last', url: 'https://last.com/', isSearch: false },
  ];
  vm.runInContext("removeFromHistory('https://last.com/')", context);
  for (const effect of effects) effect();
  // One suggestion remains, so the selection clamps onto it.
  expect(selected).toBe(0);
  selected = 0;
  expect(vm.runInContext('getSuggestions()[selectedIndex()].url', context)).toBe(
    'https://first.com/',
  );
  // Open tabs: other tabs match by title or URL and rank above the search action;
  // the current tab is never offered; picking one switches instead of navigating.
  let switched = -1;
  context.window.ipc.selectTab = (index: number) => {
    switched = index;
  };
  tabs = [
    { title: 'Home', url: 'https://current.com/', current: true },
    { title: 'Docs', url: 'https://docs.example.org/', current: false },
  ];
  input = 'docs';
  expect(vm.runInContext('getSuggestions()[0]', context)).toMatchObject({
    type: 'tab',
    tabIndex: 1,
  });
  input = 'home';
  expect(vm.runInContext('getSuggestions()[0].type', context)).toBe('action');
  input = 'example.org';
  selected = 0;
  key('Enter');
  expect(switched).toBe(1);
  expect(navigated).toBe('');
  tabs = [];
  input = 'testing search';
  key('Enter');
  expect(navigated).toBe('https://www.google.com/search?q=testing%20search');
  input = 'https://current.com/';
  selected = -1;
  key('Enter');
  expect(refreshed).toBe(true);
  expect(history.some((item) => item.title === 'Reload this page')).toBe(false);
  key('Enter', false, false, true);
  expect(navigated).toBe('https://current.com/');
  expect(history.some((item) => item.title === 'Reload this page')).toBe(false);
});
