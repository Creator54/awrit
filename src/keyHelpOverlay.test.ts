import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');

function createView(omniboxVisible: boolean) {
  const methods = [
    ['toggleOmnibox', 'toggleFind'],
    ['toggleFind', 'toggleDesignMode'],
    ['toggleKeyHelp', 'findNext'],
  ].map(([name, next]) => {
    const start = source.indexOf(`      ${name}() {`);
    return source.slice(start, source.indexOf(`\n      ${next}()`, start));
  });
  const sent: unknown[][] = [];
  let focused = '';
  const transitions = new Function('loadToolbarContent', 'getAllKeyBindings', 'setTimeout', 'options',
    `return ({${methods.join('\n')}});`)(() => {}, () => [], () => {}, {});
  const view = {
    ...transitions,
    omniboxVisible,
    keyHelpVisible: !omniboxVisible,
    findVisible: false,
    content: { webContents: { invalidate: () => {} }, focusOnWebView: () => {}, focus: () => { focused = 'page'; } },
    toolbar: {
      webContents: { isLoading: () => false, send: (...args: unknown[]) => sent.push(args) },
      focusOnWebView: () => {}, focus: () => { focused = 'toolbar'; }, setIgnoreMouseEvents: () => {},
    },
  };
  return { view, sent, focused: () => focused };
}

test('opening shortcut help closes the address bar before showing help', () => {
  const { view, sent, focused } = createView(true);
  view.toggleKeyHelp();
  expect(view.omniboxVisible).toBe(false);
  expect(sent).toEqual([
    ['omnibox:set-visible', false],
    ['awrit:set-key-help-visible', { visible: true, bindings: [] }],
  ]);
  expect(focused()).toBe('toolbar');
});

test('opening the address bar closes shortcut help before showing the address bar', () => {
  const { view, sent, focused } = createView(false);
  view.toggleOmnibox();
  expect(view.keyHelpVisible).toBe(false);
  expect(sent).toEqual([
    ['awrit:set-key-help-visible', { visible: false }],
    ['omnibox:set-visible', true],
  ]);
  expect(focused()).toBe('toolbar');
  view.toggleOmnibox();
  expect(view.keyHelpVisible).toBe(false);
  expect(focused()).toBe('page');
});

test('opening Find closes shortcut help before showing Find', () => {
  const { view, sent, focused } = createView(false);
  view.toggleFind();
  expect(view.keyHelpVisible).toBe(false);
  expect(sent).toEqual([
    ['awrit:set-key-help-visible', { visible: false }],
    ['toolbar:toggle-find', true],
  ]);
  expect(focused()).toBe('toolbar');
  view.toggleFind();
  expect(view.keyHelpVisible).toBe(false);
  expect(focused()).toBe('page');
});
