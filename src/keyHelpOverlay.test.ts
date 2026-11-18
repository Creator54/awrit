import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');

test('opening shortcut help closes the address bar before showing help', () => {
  const start = source.indexOf('      toggleKeyHelp() {');
  const end = source.indexOf('\n      findNext()', start);
  const sent: unknown[][] = [];
  const toggleKeyHelp = new Function('loadToolbarContent', 'getAllKeyBindings', 'setTimeout',
    `return ({${source.slice(start, end)}}).toggleKeyHelp;`)(() => {}, () => [], () => {});
  const view = {
    omniboxVisible: true,
    keyHelpVisible: false,
    findVisible: false,
    toggleOmnibox() {
      this.omniboxVisible = false;
      sent.push(['omnibox:set-visible', false]);
    },
    toolbar: {
      webContents: { isLoading: () => false, send: (...args: unknown[]) => sent.push(args) },
      focusOnWebView: () => {}, focus: () => {}, setIgnoreMouseEvents: () => {},
    },
  };
  toggleKeyHelp.call(view);
  expect(view.omniboxVisible).toBe(false);
  expect(sent).toEqual([
    ['omnibox:set-visible', false],
    ['awrit:set-key-help-visible', { visible: true, bindings: [] }],
  ]);
});
