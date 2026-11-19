import { expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';

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
  const toolbarContents = Object.assign(new EventEmitter(), {
    loading: false,
    isLoading() { return this.loading; },
    send: (...args: unknown[]) => sent.push(args),
  });
  const transitions = new Function('loadToolbarContent', 'getAllKeyBindings', 'setTimeout', 'options',
    `return ({${methods.join('\n')}});`)(() => {}, () => [], () => {}, {});
  const stopFindInPage = mock(() => {});
  const view = {
    ...transitions,
    omniboxVisible,
    keyHelpVisible: !omniboxVisible,
    findVisible: false,
    permissionPending: false,
    content: { webContents: { invalidate: () => {}, stopFindInPage }, focusOnWebView: () => {}, focus: () => { focused = 'page'; } },
    toolbar: {
      webContents: toolbarContents,
      focusOnWebView: mock(() => {}), focus: () => { focused = 'toolbar'; }, setIgnoreMouseEvents: mock((_ignore: boolean) => {}),
    },
  };
  return { view, sent, stopFindInPage, focused: () => focused };
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

test('closing the address bar leaves input with a pending permission prompt', () => {
  const { view, sent, focused } = createView(true);
  view.permissionPending = true;
  view.toggleOmnibox();
  expect(view.omniboxVisible).toBe(false);
  expect(sent).toEqual([['omnibox:set-visible', false]]);
  expect(view.toolbar.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  expect(view.toolbar.focusOnWebView).toHaveBeenCalledTimes(1);
  expect(focused()).toBe('toolbar');
});

test.each(['toggleFind', 'toggleOmnibox', 'toggleKeyHelp'] as const)('%s clears page highlights when closing Find', (action) => {
  const { view, sent, stopFindInPage, focused } = createView(false);
  view.keyHelpVisible = false;
  view.toggleFind();
  expect(stopFindInPage).not.toHaveBeenCalled();
  sent.length = 0;

  view[action]();
  expect(view.findVisible).toBe(false);
  expect(stopFindInPage).toHaveBeenCalledTimes(1);
  expect(stopFindInPage).toHaveBeenCalledWith('clearSelection');
  expect(sent[0]).toEqual(['toolbar:toggle-find', false]);
  expect(focused()).toBe(action === 'toggleFind' ? 'page' : 'toolbar');
});

test('clearing the Find query clears highlights without moving focus', () => {
  const start = source.indexOf('  stopFindInPageHandlers.set(toolbarContents.id,');
  const end = source.indexOf('\n\n  return', start);
  const handlers = new Map<number, () => void>();
  const contentContents = { stopFindInPage: mock(() => {}) };
  const toolbarContents = { id: 1 };
  const view = { focusedContent: toolbarContents, content: { focusOnWebView: mock(() => {}) } };
  new Function('stopFindInPageHandlers', 'toolbarContents', 'contentContents', 'view', source.slice(start, end))(
    handlers, toolbarContents, contentContents, view,
  );

  const clearQuery = handlers.get(toolbarContents.id);
  if (!clearQuery) throw new Error('Missing Find cleanup handler');
  clearQuery();
  expect(contentContents.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  expect(view.content.focusOnWebView).not.toHaveBeenCalled();
  expect(view.focusedContent).toBe(toolbarContents);
});

test('first Find open waits until the toolbar stops loading', () => {
  const { view, sent } = createView(false);
  view.keyHelpVisible = false;
  view.toolbar.webContents.loading = true;
  view.toggleFind();

  view.toolbar.webContents.emit('did-finish-load');
  expect(sent).toEqual([]);
  view.toolbar.webContents.loading = false;
  view.toolbar.webContents.emit('did-stop-loading');
  expect(sent).toEqual([['toolbar:toggle-find', true]]);
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
