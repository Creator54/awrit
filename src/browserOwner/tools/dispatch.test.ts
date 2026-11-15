import { expect, test } from 'bun:test';
import { createDispatcher, type DocumentId } from './dispatch';
import { createRegistry } from './registry';

test('a synchronously throwing handler resolves', async () => {
  const registry = createRegistry();
  registry.register({
    name: 'throws', description: 'throws', inputSchema: { type: 'object' },
    timeoutMs: 50, effect: 'observation', handler: () => { throw new Error('handler failed'); },
  });
  const dispatcher = createDispatcher(registry);
  const page = {};
  const doc = { frameUrl: 'https://example.com/', navId: 42 };
  dispatcher.updatePaneBinding('pane', { currentDocument: doc, clientSocket: {} as never, webContents: page as never });
  const result = await Promise.race([
    dispatcher.call('pane', 'throws', {}, doc, 50),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 100)),
  ]);
  expect(result).toEqual({ ok: false, error: 'handler failed' });
});

test('dispatches calls pinned to current document of the caller pane', async () => {
  const registry = createRegistry();
  registry.register({
    name: 'test',
    description: 'Test tool',
    inputSchema: { type: 'object' as const },
    timeoutMs: 5000,
    effect: 'observation',
    handler: async (input) => ({ result: input }),
  });

  const dispatcher = createDispatcher(registry);
  const paneId = 'pane1';
  const doc1: DocumentId = { frameUrl: 'http://example.com/page1', navId: 1 };
  const doc2: DocumentId = { frameUrl: 'http://example.com/page2', navId: 2 };

  // Bind pane to initial document
  dispatcher.updatePaneBinding(paneId, { currentDocument: doc1, clientSocket: 'sock1' as never, webContents: {} as never });

  // Call succeeds on current document
  const result1 = await dispatcher.call(paneId, 'test', {}, doc1, 5000);
  expect(result1).toEqual({ ok: true, result: { result: {} } });

  // Navigation changes document
  dispatcher.updatePaneBinding(paneId, { currentDocument: doc2, clientSocket: 'sock1' as never, webContents: {} as never });

  // Call to old document returns not-started
  const call2 = await dispatcher.call(paneId, 'test', {}, doc1, 5000);
  expect(call2).toEqual({ ok: false, outcome: 'not-started' });
});

test('serializes calls per document, rejects concurrent mutations', async () => {
  const registry = createRegistry();
  let running = 0;
  let maxConcurrent = 0;
  registry.register({
    name: 'mut',
    description: 'Mutation',
    inputSchema: { type: 'object' as const },
    timeoutMs: 100,
    effect: 'mutation',
    handler: async () => {
      running++;
      maxConcurrent = Math.max(maxConcurrent, running);
      await new Promise((r) => setTimeout(r, 50));
      running--;
      return {};
    },
  });

  const dispatcher = createDispatcher(registry);
  const paneId = 'pane1';
  const doc: DocumentId = { frameUrl: 'http://example.com', navId: 1 };
  dispatcher.updatePaneBinding(paneId, { currentDocument: doc, clientSocket: 'sock1' as never, webContents: {} as never });

  // Start two mutations simultaneously; second waits for first
  const p1 = dispatcher.call(paneId, 'mut', {}, doc, 100);
  const p2 = dispatcher.call(paneId, 'mut', {}, doc, 100);

  await Promise.all([p1, p2]);
  expect(maxConcurrent).toBe(1);
});

test('rejects work when queue full, observation timeout and mutation unknown', async () => {
  const registry = createRegistry();
  registry.register({
    name: 'obs',
    description: 'Observation',
    inputSchema: { type: 'object' as const },
    timeoutMs: 50,
    effect: 'observation',
    handler: async () => {
      await new Promise((r) => setTimeout(r, 100)); // exceed 50ms timeout
      return {};
    },
  });
  registry.register({
    name: 'mut',
    description: 'Mutation',
    inputSchema: { type: 'object' as const },
    timeoutMs: 50,
    effect: 'mutation',
    handler: async () => {
      await new Promise((r) => setTimeout(r, 100));
      return {};
    },
  });

  const dispatcher = createDispatcher(registry);
  const paneId = 'pane1';
  const doc: DocumentId = { frameUrl: 'http://example.com', navId: 1 };
  dispatcher.updatePaneBinding(paneId, { currentDocument: doc, clientSocket: 'sock1' as never, webContents: {} as never });

  // Start 9 observation calls (1 running, 8 queued max)
  const calls = [];
  for (let i = 0; i < 9; i++) {
    calls.push(dispatcher.call(paneId, 'obs', {}, doc, 50));
  }
  // 10th should be rejected before running
  const full = await dispatcher.call(paneId, 'obs', {}, doc, 50);
  expect(full).toEqual({ ok: false, outcome: 'not-started' });

  // Let the 9 queued calls timeout
  const results = await Promise.all(calls);
  expect(results.every((r: any) => r.outcome === 'observation-timeout')).toBe(true);
});

test('observation timeout returns immediately, no blocking on handler settlement', async () => {
  const registry = createRegistry();
  registry.register({
    name: 'obs',
    description: 'Observation',
    inputSchema: { type: 'object' as const },
    timeoutMs: 50,
    effect: 'observation',
    handler: async () => {
      await new Promise((r) => setTimeout(r, 200));
      return {};
    },
  });

  const dispatcher = createDispatcher(registry);
  const paneId = 'pane1';
  const doc: DocumentId = { frameUrl: 'http://example.com', navId: 1 };
  dispatcher.updatePaneBinding(paneId, { currentDocument: doc, clientSocket: 'sock1' as never, webContents: {} as never });

  const timeout = dispatcher.call(paneId, 'obs', {}, doc, 50);
  const result = await timeout;
  expect(result).toEqual({ ok: false, outcome: 'observation-timeout' });
});

test('disconnects abort queued work cleanly', async () => {
  const registry = createRegistry();
  const calls: string[] = [];
  registry.register({
    name: 'obs',
    description: 'Observation',
    inputSchema: { type: 'object' as const },
    timeoutMs: 5000,
    effect: 'observation',
    handler: async () => {
      calls.push('start');
      await new Promise((r) => setTimeout(r, 50));
      calls.push('end');
      return {};
    },
  });

  const dispatcher = createDispatcher(registry);
  const paneId = 'pane1';
  const doc: DocumentId = { frameUrl: 'http://example.com', navId: 1 };
  dispatcher.updatePaneBinding(paneId, { currentDocument: doc, clientSocket: 'sock1' as never, webContents: {} as never });

  const first = dispatcher.call(paneId, 'obs', {}, doc, 5000);
  const second = dispatcher.call(paneId, 'obs', {}, doc, 5000);
  await new Promise((r) => setTimeout(r, 10));

  dispatcher.disconnectSocket('sock1' as never);

  expect(await second).toEqual({ ok: false, outcome: 'not-started' });
  expect((await first).ok).toBe(true);
  // Running call completes; queued call never starts
  expect(calls).toEqual(['start', 'end']);
});

test('handler receives the pane webContents from its binding', async () => {
  const registry = createRegistry();
  registry.register({
    name: 'who',
    description: 'Echo the context',
    inputSchema: { type: 'object' as const },
    timeoutMs: 1000,
    effect: 'observation',
    handler: async (_input, ctx) => ({ wc: ctx.webContents }),
  });
  const dispatcher = createDispatcher(registry);
  const doc: DocumentId = { frameUrl: 'http://example.com', navId: 1 };
  const wc = { id: 'wc-a' } as never;
  dispatcher.updatePaneBinding('a', { currentDocument: doc, clientSocket: 's' as never, webContents: wc });

  expect(await dispatcher.call('a', 'who', {}, doc, 1000)).toEqual({ ok: true, result: { wc } });
});

test('tool failures are reported as ok:false, not ok:true', async () => {
  const registry = createRegistry();
  registry.register({
    name: 'soft',
    description: 'Returns a failure result',
    inputSchema: { type: 'object' as const },
    timeoutMs: 1000,
    effect: 'mutation',
    handler: async () => ({ ok: false, error: 'Element not found' }),
  });
  registry.register({
    name: 'hard',
    description: 'Throws',
    inputSchema: { type: 'object' as const },
    timeoutMs: 1000,
    effect: 'mutation',
    handler: async () => {
      throw new Error('boom');
    },
  });
  const dispatcher = createDispatcher(registry);
  const doc: DocumentId = { frameUrl: 'http://example.com', navId: 1 };
  dispatcher.updatePaneBinding('a', { currentDocument: doc, clientSocket: 's' as never, webContents: {} as never });

  expect(await dispatcher.call('a', 'soft', {}, doc, 1000)).toEqual({ ok: false, error: 'Element not found' });
  expect(await dispatcher.call('a', 'hard', {}, doc, 1000)).toEqual({ ok: false, error: 'boom' });
});

test('rejects input that does not match the tool schema before running it', async () => {
  const registry = createRegistry();
  let ran = false;
  registry.register({
    name: 'typed',
    description: 'Needs a string',
    inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } }, required: ['text'] },
    timeoutMs: 1000,
    effect: 'mutation',
    handler: async () => {
      ran = true;
      return {};
    },
  });
  const dispatcher = createDispatcher(registry);
  const doc: DocumentId = { frameUrl: 'http://example.com', navId: 1 };
  dispatcher.updatePaneBinding('a', { currentDocument: doc, clientSocket: 's' as never, webContents: {} as never });

  expect(await dispatcher.call('a', 'typed', { text: 5 }, doc, 1000)).toEqual({ ok: false, error: 'Expected string for text' });
  expect(await dispatcher.call('a', 'typed', {}, doc, 1000)).toEqual({ ok: false, error: 'Missing required field: text' });
  expect(ran).toBe(false);
});

test('disconnecting one client aborts only its own queued calls', async () => {
  const registry = createRegistry();
  const release: Array<() => void> = [];
  registry.register({
    name: 'slow',
    description: 'Waits until released',
    inputSchema: { type: 'object' as const },
    timeoutMs: 5000,
    effect: 'mutation',
    handler: () => new Promise((resolve) => release.push(() => resolve({ done: true }))),
  });
  const dispatcher = createDispatcher(registry);
  const doc: DocumentId = { frameUrl: 'http://example.com', navId: 1 };
  const bind = (socket: string) =>
    dispatcher.updatePaneBinding('a', { currentDocument: doc, clientSocket: socket as never, webContents: {} as never });

  const tick = () => new Promise((r) => setTimeout(r, 5));
  bind('s1');
  const running = dispatcher.call('a', 'slow', {}, doc, 5000);
  await tick();
  bind('s2');
  const mine = dispatcher.call('a', 'slow', {}, doc, 5000);
  await tick();
  bind('s3');
  const other = dispatcher.call('a', 'slow', {}, doc, 5000);
  await tick();

  dispatcher.disconnectSocket('s2' as never);
  expect(await mine).toEqual({ ok: false, outcome: 'not-started' });

  release.shift()?.();
  await running;
  await new Promise((r) => setTimeout(r, 10));
  release.shift()?.();
  expect((await other).ok).toBe(true);
});
