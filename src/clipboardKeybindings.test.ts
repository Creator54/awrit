import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../config.js', import.meta.url), 'utf8');
const clipboardSource = source.slice(
  source.indexOf('// Clipboard timeout'),
  source.indexOf('/** @type {KeyBindingAction} */\nfunction quit'),
);

test('remote copy callback bypasses both host clipboard and host terminal', async () => {
  const forwarded: string[] = [];
  const context = vm.createContext({
    console,
    Buffer,
    setImmediate,
    process: {
      platform: 'linux',
      env: {},
      stdout: {
        write: () => {
          throw new Error('host stdout accessed');
        },
      },
    },
    exec: () => {
      throw new Error('host clipboard fallback accessed');
    },
    require: () => {
      throw new Error('host clipboard accessed');
    },
  });
  vm.runInContext(
    clipboardSource
      .replace(/^const \{ exec \}.*$/m, '')
      .replace(/^const (electron|fs|os|path) = .*$/gm, ''),
    context,
  );
  await vm.runInContext('writeToSystemClipboard', context)('remote selection', {
    onCopyToClipboard: (text: string) => forwarded.push(text),
  });
  expect(forwarded).toEqual(['remote selection']);
});

test('copy binding writes the selection to the pane terminal, not the owner log', async () => {
  const osc52: string[] = [];
  const electronWrites: string[] = [];
  const stdout: string[] = [];
  const context = vm.createContext({
    console,
    Buffer,
    setImmediate,
    process: { platform: 'linux', env: {}, stdout: { write: (s: string) => stdout.push(s) } },
    exec: () => undefined,
    require: (name: string) => {
      if (name !== 'electron') throw new Error(`Unexpected module: ${name}`);
      return { clipboard: { writeText: (t: string) => electronWrites.push(t) } };
    },
  });
  vm.runInContext(
    clipboardSource
      .replace(/^const \{ exec \}.*$/m, '')
      .replace(/^const (electron|fs|os|path) = .*$/gm, ''),
    context,
  );
  const view = {
    focusedContent: { executeJavaScript: async () => 'selected text' },
    terminal: { output: { writeToTerminalClipboard: (t: string) => osc52.push(t) } },
  };
  vm.runInContext('copy', context)({ view });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(electronWrites).toEqual(['selected text']);
  expect(osc52).toEqual(['selected text']);
  expect(stdout).toEqual([]);
});
