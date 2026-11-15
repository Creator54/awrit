import { expect, test } from 'bun:test';
import { createDispatcher } from './tools/dispatch';
import { createRegistry } from './tools/registry';

test('tools:list returns registry metadata', async () => {
  const registry = createRegistry();
  registry.register({
    name: 'screenshot',
    description: 'Take a screenshot',
    inputSchema: { type: 'object' as const },
    timeoutMs: 5000,
    effect: 'observation',
    handler: async () => ({ ok: true }),
  });

  const list = registry.listTools();
  expect(list).toHaveLength(1);
  expect(list[0].name).toBe('screenshot');
  expect(list[0].description).toBe('Take a screenshot');
  expect(list[0].timeoutMs).toBe(5000);
  expect(list[0].effect).toBe('observation');
});

test('tool:call routes to dispatcher with document pinning', async () => {
  const registry = createRegistry();
  registry.register({
    name: 'test_tool',
    description: 'Test',
    inputSchema: { type: 'object' as const },
    timeoutMs: 5000,
    effect: 'observation',
    handler: async (input) => ({ result: input }),
  });

  const dispatcher = createDispatcher(registry);
  const paneId = 'pane1';
  const doc = { frameUrl: 'http://example.com', navId: 1 };

  dispatcher.updatePaneBinding(paneId, {
    currentDocument: doc,
    clientSocket: 'sock1' as never, webContents: {} as never,
  });

  // Simulate the tool call (dispatcher is already tested separately)
  const result = await dispatcher.call(paneId, 'test_tool', { test: true }, doc, 5000);
  expect(result).toEqual({ ok: true, result: { result: { test: true } } });
});

test('tool:call rejects calls to wrong document', async () => {
  const registry = createRegistry();
  registry.register({
    name: 'test',
    description: 'Test',
    inputSchema: { type: 'object' as const },
    timeoutMs: 5000,
    effect: 'observation',
    handler: async () => ({}),
  });

  const dispatcher = createDispatcher(registry);
  const paneId = 'pane1';
  const doc1 = { frameUrl: 'http://example.com/page1', navId: 1 };
  const doc2 = { frameUrl: 'http://example.com/page2', navId: 2 };

  dispatcher.updatePaneBinding(paneId, {
    currentDocument: doc1,
    clientSocket: 'sock1' as never, webContents: {} as never,
  });

  // Navigation changes document
  dispatcher.updatePaneBinding(paneId, {
    currentDocument: doc2,
    clientSocket: 'sock1' as never, webContents: {} as never,
  });

  // Call pinned to old document should be rejected
  const result = await dispatcher.call(paneId, 'test', {}, doc1, 5000);
  expect(result).toEqual({ ok: false, outcome: 'not-started' });
});

test('socket disconnect cleans up dispatcher state', async () => {
  const registry = createRegistry();
  registry.register({
    name: 'test',
    description: 'Test',
    inputSchema: { type: 'object' as const },
    timeoutMs: 5000,
    effect: 'observation',
    handler: async () => ({}),
  });

  const dispatcher = createDispatcher(registry);
  const paneId = 'pane1';
  const doc = { frameUrl: 'http://example.com', navId: 1 };
  const socket = 'sock1' as any;

  dispatcher.updatePaneBinding(paneId, {
    currentDocument: doc,
    clientSocket: socket,
  });

  // Disconnect should clean up bindings
  dispatcher.disconnectSocket(socket);

  // Next call on same paneId should fail (binding removed)
  const result = await dispatcher.call(paneId, 'test', {}, doc, 5000);
  expect(result).toEqual({ ok: false, outcome: 'not-started' });
});
