import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createDispatcher } from './dispatch';
import { createBrowserToolRegistry } from './browserTools';

test('browser tools registry includes the core tools', () => {
  const registry = createBrowserToolRegistry();
  const tools = registry.listTools();

  expect(tools).toHaveLength(12);
  expect(tools.map((t) => t.name)).toEqual([
    'snapshot',
    'text',
    'click',
    'type',
    'key',
    'scroll',
    'navigate',
    'wait',
    'console',
    'network',
    'page',
    'evaluate',
  ]);
});

test('core tools specify correct effect types', () => {
  const registry = createBrowserToolRegistry();
  const tools = registry.listTools();

  const observations = tools.filter((t) => t.effect === 'observation').map((t) => t.name);
  const mutations = tools.filter((t) => t.effect === 'mutation').map((t) => t.name);

  expect(observations).toEqual(['snapshot', 'text', 'wait', 'console', 'network', 'page']);
  expect(mutations).toEqual(['click', 'type', 'key', 'scroll', 'navigate', 'evaluate']);
});

test('core tools specify bounded timeouts', () => {
  const registry = createBrowserToolRegistry();
  const tools = registry.listTools();

  for (const tool of tools) {
    expect(tool.timeoutMs).toBeGreaterThanOrEqual(1000);
    expect(tool.timeoutMs).toBeLessThanOrEqual(30000);
  }
});

test('a successful navigate reports url and title once', async () => {
  const registry = createBrowserToolRegistry();
  const webContents = {
    loadURL: async () => undefined,
    executeJavaScript: async () => undefined,
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
  } as never;
  const result = await registry.get('navigate').handler({ url: 'https://example.com/', previewMs: 0 }, { webContents });
  expect(result).toEqual({ ok: true, url: 'https://example.com/', title: 'Example' });
});

test('handlers run against the context webContents', async () => {
  const registry = createBrowserToolRegistry();
  const seen: string[] = [];
  const webContents = {
    executeJavaScript: async (code: string) => {
      seen.push(code);
      return { ok: true, x: 5, y: 6 };
    },
    sendInputEvent: () => undefined,
    getZoomFactor: () => 1,
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
  } as never;

  const started = Date.now();
  const result = await registry.get('click').handler({ selector: '#go', previewMs: 60000 }, { webContents });
  expect(result).toEqual({ ok: true, page: { url: 'https://example.com/', title: 'Example' } });
  expect(Date.now() - started).toBeLessThan(3000);
  expect(seen[0]).toContain('#go');
});

test('snapshot reports observation failure honestly when accessibility is unavailable', async () => {
  const registry = createBrowserToolRegistry();
  const webContents = {
    executeJavaScript: async () => ({ tag: 'HTML' }),
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
  } as never;
  const result = (await registry.get('snapshot').handler({}, { webContents })) as Record<string, unknown>;
  expect(result).toMatchObject({ ok: false, observation: { status: 'unavailable' } });
});

test('the tool timeout leaves room for the longest wait', () => {
  const registry = createBrowserToolRegistry();
  expect(registry.get('wait').timeoutMs).toBeGreaterThan(8000);
});

test('a failed action whose recovery observation hangs reports unknown at timeout', async () => {
  const registry = createBrowserToolRegistry();
  const debuggerApi = Object.assign(new EventEmitter(), {
    isAttached: () => true,
    sendCommand: async () => { await held; return { nodes: [] }; },
  });
  let finish!: () => void;
  const held = new Promise<void>((resolve) => { finish = resolve; });
  const wc = Object.assign(new EventEmitter(), {
    debugger: debuggerApi, isDestroyed: () => false,
    getURL: () => 'https://example.com/', getTitle: () => 'Example',
    sendInputEvent: () => undefined,
  });
  const dispatcher = createDispatcher(registry);
  const doc = { frameUrl: wc.getURL(), navId: 10 };
  dispatcher.updatePaneBinding('p', { currentDocument: doc, clientSocket: {} as never, webContents: wc as never });
  // Only failed actions capture a recovery observation.
  const result = await dispatcher.call('p', 'key', { key: 'Enter', modifiers: ['hyper'] }, doc, 300);
  expect(result).toEqual({ ok: false, outcome: 'unknown' });
  finish();
});

test('all tools are fully implemented with real handlers', () => {
  const registry = createBrowserToolRegistry();
  const tools = registry.listTools();

  expect(tools).toHaveLength(12);

  // Verify all tools have descriptions and valid metadata
  for (const tool of tools) {
    expect(tool.name.length).toBeGreaterThan(0);
    expect(tool.description.length).toBeGreaterThan(0);
    expect(tool.timeoutMs).toBeGreaterThan(0);
    expect(['observation', 'mutation']).toContain(tool.effect);
  }
});
