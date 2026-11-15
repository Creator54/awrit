import { expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

test('only trusted copy events synchronize selected text to the terminal', () => {
  const windowListeners = new Map<string, (event: unknown) => void>();
  const documentListeners = new Map<string, (event: unknown) => void>();
  const sent: unknown[][] = [];
  let injected = '';
  const window = {
    addEventListener: (name: string, listener: (event: unknown) => void) => windowListeners.set(name, listener),
    getSelection: () => ({ toString: () => 'selected text' }),
  };
  const document = {
    addEventListener: (name: string, listener: (event: unknown) => void) => documentListeners.set(name, listener),
    documentElement: null,
  };
  vm.runInNewContext(fs.readFileSync(path.join(import.meta.dir, 'content-preload.js'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: () => {} },
      ipcRenderer: { send: (...args: unknown[]) => sent.push(args), on: () => {} },
      webFrame: { executeJavaScriptInIsolatedWorld: (_id: number, scripts: { code: string }[]) => {
        injected = scripts[0].code;
        return Promise.resolve();
      } },
    }),
    window, document, process: { isMainFrame: true }, setInterval: () => {}, console,
  });
  windowListeners.get('message')?.({ data: { type: 'awrit:copy', text: 'forged' } });
  expect(sent).toEqual([]);
  expect(injected).not.toContain('awrit:copy');
  const copy = documentListeners.get('copy');
  if (!copy) throw new Error('Trusted copy listener is missing');
  copy({ isTrusted: false });
  expect(sent).toEqual([]);
  copy({ isTrusted: true });
  expect(sent).toEqual([['awrit:copy-to-clipboard', 'selected text']]);
});

test('the bridge retries through the main process without a page-supplied URL', () => {
  let bridge: { retry: () => void } | undefined;
  const sent: unknown[][] = [];
  vm.runInNewContext(fs.readFileSync(path.join(import.meta.dir, 'content-preload.js'), 'utf8'), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name: string, api: { retry: () => void }) => { bridge = api; } },
      ipcRenderer: { send: (...args: unknown[]) => sent.push(args), on: () => {} },
      webFrame: { executeJavaScriptInIsolatedWorld: () => Promise.resolve() },
    }),
    window: { addEventListener: () => {} },
    document: { addEventListener: () => {}, documentElement: null },
    process: { isMainFrame: true }, setInterval: () => {}, console,
  });
  bridge?.retry();
  expect(sent).toEqual([['awrit:retry']]);
});
