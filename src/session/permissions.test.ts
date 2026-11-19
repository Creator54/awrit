import { expect, mock, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';

async function permissionHarness() {
  type CheckHandler = (contents: unknown, permission: string, origin: string) => boolean;
  type RequestHandler = (contents: unknown, permission: string, callback: (allow: boolean) => void, details: { requestingUrl: string }) => void;
  let check: CheckHandler | undefined;
  let request: RequestHandler | undefined;
  const session = {
    getUserAgent: () => 'Chromium awrit/test',
    setUserAgent: () => {},
    setSpellCheckerEnabled: () => {},
    setCertificateVerifyProc: () => {},
    setPermissionCheckHandler: (handler: CheckHandler) => { check = handler; },
    setPermissionRequestHandler: (handler: RequestHandler) => { request = handler; },
    webRequest: { onBeforeSendHeaders: () => {}, onHeadersReceived: () => {} },
  };
  const page = new EventEmitter();
  const toolbar = Object.assign(new EventEmitter(), {
    id: 42, send: () => {}, session,
    setIgnoreMouseEvents: () => {}, focusOnWebView: () => {},
  });
  const view = {
    designMode: false,
    content: { webContents: page, focusOnWebView: mock(() => {}) },
    toolbar: {
      webContents: toolbar,
      setIgnoreMouseEvents: mock((_ignore: boolean) => {}),
      focusOnWebView: mock(() => {}),
    },
  };
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const electron = {
    app: { whenReady: () => Promise.resolve(), getPath: () => '/tmp' },
    session: { fromPartition: () => session },
    ipcMain: { handle: () => {}, on: (name: string, callback: (...args: unknown[]) => void) => listeners.set(name, callback) },
  };
  const source = fs.readFileSync(path.join(import.meta.dir, '..', 'session.ts'), 'utf8');
  const isolatedSource = source
    .replace(/^import .* from 'electron';$/m, "const { app, session: ElectronSession, ipcMain } = require('electron');")
    .replace(/^import \{(.*)\} from '(\.[^']+)';$/gm, "const {$1} = require('$2');")
    .replace(/^export /gm, '');
  const compiled = new Bun.Transpiler({ loader: 'ts', target: 'node' }).transformSync(isolatedSource);
  const getProfileSession = vm.runInNewContext(`${compiled}\ngetProfileSession;`, {
    require: (name: string) => {
      if (name === './windows') return { managedViews: [view] };
      if (name === 'electron') return electron;
      if (name === './browserOwner/profile')
        return { profilePartition: () => 'test-partition', legacyPartitionExists: () => false };
      if (name === './downloads') return { downloadsFolder: () => '/tmp', handleDownloads: () => {} };
      if (name === './folderGrants') return { permitsFileSystem: () => false };
      throw new Error(`Unexpected import: ${name}`);
    },
    URL,
  });
  await getProfileSession(null);
  if (!check || !request) throw new Error('Permission handlers not installed');
  return { check, request, page, toolbar, listeners, view };
}

test('websites cannot automatically read the clipboard', async () => {
  const { check, request } = await permissionHarness();
  for (const origin of ['https://untrusted.example', 'http://localhost:3000']) {
    expect(check(null, 'clipboard-read', origin)).toBe(false);
    let allowed: boolean | undefined;
    request(null, 'clipboard-read', (value) => { allowed = value; }, { requestingUrl: origin });
    expect(allowed).toBe(false);
  }
  expect(check(null, 'fullscreen', 'https://untrusted.example')).toBe(true);
  expect(check(null, 'clipboard-sanitized-write', 'https://untrusted.example')).toBe(true);
});

test('answered prompts remove destruction listeners and ignore duplicate answers', async () => {
  const harness = await permissionHarness();
  const results: boolean[] = [];
  harness.request(harness.page, 'geolocation', (allowed) => results.push(allowed), {
    requestingUrl: 'https://untrusted.example',
  });
  const answer = harness.listeners.get('toolbar:permission-response');
  if (!answer) throw new Error('Permission response handler missing');
  const response = { id: 1, allowed: true, url: 'https://untrusted.example', permission: 'geolocation' };
  answer({ sender: { id: -1 } }, response);
  expect(results).toEqual([]);
  answer({ sender: harness.toolbar }, response);
  answer({ sender: harness.toolbar }, response);
  expect(results).toEqual([true]);
  harness.page.emit('destroyed');
  harness.toolbar.emit('destroyed');
  expect(results).toEqual([true]);
  expect(harness.page.listenerCount('destroyed')).toBe(0);
  expect(harness.toolbar.listenerCount('destroyed')).toBe(0);
});

test('a stale response cannot steal focus from the replacement permission prompt', async () => {
  const { view, page, toolbar, request, listeners } = await permissionHarness();
  const url = 'https://untrusted.example';
  const results: boolean[] = [];
  request(page, 'geolocation', (allowed) => results.push(allowed), { requestingUrl: url });
  request(page, 'notifications', (allowed) => results.push(allowed), { requestingUrl: url });
  const answer = listeners.get('toolbar:permission-response');
  if (!answer) throw new Error('Permission response handler missing');
  answer({ sender: toolbar }, { id: 1, allowed: false, url, permission: 'geolocation' });

  expect(results).toEqual([false]);
  expect(view.toolbar.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false);
  expect(view.content.focusOnWebView).not.toHaveBeenCalled();

  answer({ sender: toolbar }, { id: 2, allowed: true, url, permission: 'notifications' });
  expect(results).toEqual([false, true]);
  expect(view.toolbar.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
  expect(view.content.focusOnWebView).toHaveBeenCalledTimes(1);
});

test.each([true, false])('permission dismissal restores the input owner (Design Mode: %s)', async (designMode) => {
  const { view, page, toolbar, request, listeners } = await permissionHarness();
  view.designMode = designMode;
  const results: boolean[] = [];
  const url = 'https://untrusted.example';
  request(page, 'geolocation', (allowed) => results.push(allowed), { requestingUrl: url });
  view.toolbar.focusOnWebView.mockClear();
  const answer = listeners.get('toolbar:permission-response');
  if (!answer) throw new Error('Permission response handler missing');
  answer({ sender: toolbar }, { id: 1, allowed: false, url, permission: 'geolocation' });

  expect(results).toEqual([false]);
  expect(view.toolbar.setIgnoreMouseEvents).toHaveBeenLastCalledWith(!designMode);
  expect(view.toolbar.focusOnWebView).toHaveBeenCalledTimes(designMode ? 1 : 0);
  expect(view.content.focusOnWebView).toHaveBeenCalledTimes(designMode ? 0 : 1);
});

for (const destroyed of ['page', 'toolbar'] as const) {
  test(`pending permissions are denied once when ${destroyed} is destroyed`, async () => {
    const harness = await permissionHarness();
    const results: boolean[] = [];
    harness.request(harness.page, 'geolocation', (allowed) => results.push(allowed), {
      requestingUrl: 'https://untrusted.example',
    });
    harness[destroyed].emit('destroyed');
    expect(results).toEqual([false]);
    harness.page.emit('destroyed');
    harness.toolbar.emit('destroyed');
    expect(results).toEqual([false]);
    expect(harness.page.listenerCount('destroyed')).toBe(0);
    expect(harness.toolbar.listenerCount('destroyed')).toBe(0);
  });
}
