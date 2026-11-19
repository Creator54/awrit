import { expect, mock, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../windows.ts', import.meta.url), 'utf8');
const start = source.indexOf('      toggleDesignMode() {');
const end = source.indexOf('\n      toggleKeyHelp()', start);
const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(`const methods = {${source.slice(start, end)}};`);
const { toggleDesignMode } = new Function('terminalReview', 'console_', 'loadToolbarContent', 'withoutAgentPreview', `${code}; return methods;`)(
  false, { log() {} }, () => {}, () => new Promise(() => {}),
);

test('first Design Mode open waits until the toolbar stops loading', () => {
  let loading = true;
  const contents = Object.assign(new EventEmitter(), {
    isLoading: () => loading,
    send: mock(() => {}),
  });
  const view = {
    designMode: false,
    content: { webContents: { send: () => {} } },
    toolbar: { webContents: contents, setIgnoreMouseEvents: () => {}, focusOnWebView: () => {}, focus: () => {} },
  };

  toggleDesignMode.call(view);
  contents.emit('did-finish-load');
  expect(contents.send).not.toHaveBeenCalled();
  loading = false;
  contents.emit('did-stop-loading');
  expect(contents.send).toHaveBeenCalledTimes(1);
  expect(contents.send).toHaveBeenCalledWith('awrit:design-mode-changed', true);
});

test.each(['permissionPending', 'findVisible', 'page'] as const)('exiting Design Mode restores input to %s', (owner) => {
  const toolbarOwnsInput = owner !== 'page';
  const view = {
    designMode: true,
    permissionPending: owner === 'permissionPending',
    findVisible: owner === 'findVisible',
    content: {
      isSuppressingPaint: true,
      webContents: { invalidate: mock(() => {}), send: () => {} },
      focusOnWebView: mock(() => {}),
      focus: () => {},
    },
    toolbar: {
      webContents: { isLoading: () => false, send: () => {} },
      setIgnoreMouseEvents: mock((_ignore: boolean) => {}),
      focusOnWebView: mock(() => {}),
      focus: () => {},
    },
  };

  toggleDesignMode.call(view);
  expect(view.designMode).toBe(false);
  expect(view.content.isSuppressingPaint).toBe(false);
  expect(view.content.webContents.invalidate).toHaveBeenCalledTimes(1);
  expect(view.toolbar.setIgnoreMouseEvents).toHaveBeenCalledWith(!toolbarOwnsInput);
  expect(view.content.focusOnWebView).toHaveBeenCalledTimes(toolbarOwnsInput ? 0 : 1);
  expect(view.toolbar.focusOnWebView).toHaveBeenCalledTimes(toolbarOwnsInput ? 1 : 0);
});
