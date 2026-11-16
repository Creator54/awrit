import { expect, test } from 'bun:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
const branch = source.slice(
  source.indexOf('    const stopContentFileChooser ='),
  source.indexOf('    onFailure(stopContentFileChooser);'),
);

function run(platform: string, windowOptions: Record<string, unknown>) {
  const setups: ((options: Electron.OpenDialogOptions) => unknown)[] = [];
  const dialogs: Electron.OpenDialogOptions[] = [];
  const hooks: string[] = [];
  const failures: (() => void)[] = [];
  const closed: boolean[] = [];
  const webContents = {};
  const context = vm.createContext({
    Promise,
    process: { platform },
    content: { webContents, close: () => closed.push(true) },
    dialog: {
      showOpenDialog: async (options: Electron.OpenDialogOptions) => {
        dialogs.push(options);
        return { canceled: false, filePaths: ['/host/file'] };
      },
    },
    windowOptions: {
      ...windowOptions,
      ...(windowOptions.onFileChooserUnsupported
        ? { onFileChooserUnsupported: () => hooks.push('hook') }
        : {}),
    },
    setupFileChooser: (
      _contents: unknown,
      show: (options: Electron.OpenDialogOptions) => unknown,
      unavailable?: () => void,
    ) => {
      if (unavailable) failures.push(unavailable);
      setups.push(show);
      return () => {};
    },
  });
  // Execute the actual windows.ts branch, not a copy.
  vm.runInContext(branch, context);
  return { setups, dialogs, hooks, webContents, failures, closed };
}

test('a remote pane intercepts the file chooser on every platform', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const state = run(platform, { onFileChooserUnsupported: () => {} });
    expect(state.setups).toHaveLength(1);
    expect(state.dialogs).toEqual([]);
  }
});

test('a remote file chooser reports unsupported and cancels without a host dialog', async () => {
  const state = run('darwin', { onFileChooserUnsupported: () => {} });
  const result = await state.setups[0]?.({ properties: ['openFile'] });
  expect(state.hooks).toEqual(['hook']);
  expect(result).toEqual({ canceled: true, filePaths: [] });
  expect(state.dialogs).toEqual([]);
});

test('file chooser teardown belongs to destruction, not the resize paint destructors', () => {
  expect(source).not.toContain(
    'destructors.push(stopToolbarDragAndDrop, stopContentDragAndDrop, stopContentFileChooser)',
  );
  expect(source).toContain('stopContentFileChooser();');
});

test('remote interception failure closes the page rather than allowing a native dialog', () => {
  const state = run('darwin', { onFileChooserUnsupported: () => {} });
  state.failures[0]?.();
  expect(state.closed).toEqual([true]);
  expect(state.hooks).toEqual(['hook']);
  expect(state.dialogs).toEqual([]);
});

test('local linux keeps the host dialog', async () => {
  const state = run('linux', {});
  expect(state.setups).toHaveLength(1);
  const result = await state.setups[0]?.({ properties: ['openFile'] });
  expect(state.dialogs).toEqual([{ properties: ['openFile'] }]);
  expect(result).toEqual({ canceled: false, filePaths: ['/host/file'] });
});

test('local non-linux leaves Chromium alone', () => {
  const state = run('darwin', {});
  expect(state.setups).toEqual([]);
  expect(state.dialogs).toEqual([]);
});
