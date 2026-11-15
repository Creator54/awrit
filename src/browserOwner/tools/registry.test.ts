import { expect, test } from 'bun:test';
import { createRegistry, type ToolDefinition } from './registry';

test('registers unique tool definitions by name', () => {
  const registry = createRegistry();
  const toolDef: ToolDefinition = {
    name: 'test_tool',
    description: 'A test tool',
    inputSchema: { type: 'object' as const, properties: { text: { type: 'string' } } },
    timeoutMs: 5000,
    effect: 'observation',
    handler: async () => ({ ok: true }),
  };
  registry.register(toolDef);
  expect(registry.get('test_tool')).toBe(toolDef);
  expect(() => registry.register(toolDef)).toThrow('already registered');
});

test('rejects unknown tool names and handles missing definitions', () => {
  const registry = createRegistry();
  expect(() => registry.get('missing')).toThrow('Unknown tool');
  expect(registry.listTools()).toEqual([]);
});

test('validates input against schema before dispatch', async () => {
  const registry = createRegistry();
  const handler = async (input: unknown) => ({ received: input });
  registry.register({
    name: 'schema_test',
    description: 'Test schema validation',
    inputSchema: { type: 'object' as const, properties: { id: { type: 'number' } }, required: ['id'] },
    timeoutMs: 5000,
    effect: 'observation',
    handler,
  });
  const validated = await registry.validate('schema_test', { id: 42 });
  expect(validated).toEqual({ id: 42 });
  await expect(registry.validate('schema_test', { id: 'bad' })).rejects.toThrow('Expected number');
});

test('lists all registered tools with metadata', () => {
  const registry = createRegistry();
  registry.register({
    name: 'tool1',
    description: 'First tool',
    inputSchema: { type: 'object' as const },
    timeoutMs: 3000,
    effect: 'observation',
    handler: async () => ({}),
  });
  registry.register({
    name: 'tool2',
    description: 'Second mutation',
    inputSchema: { type: 'object' as const },
    timeoutMs: 10000,
    effect: 'mutation',
    handler: async () => ({}),
  });
  const list = registry.listTools();
  expect(list).toHaveLength(2);
  expect(list.map((t) => ({ name: t.name, description: t.description, effect: t.effect, timeoutMs: t.timeoutMs }))).toEqual(
    expect.arrayContaining([
      { name: 'tool1', description: 'First tool', effect: 'observation', timeoutMs: 3000 },
      { name: 'tool2', description: 'Second mutation', effect: 'mutation', timeoutMs: 10000 },
    ]),
  );
});

test('rejects tools with invalid schemas or missing handlers', () => {
  const registry = createRegistry();
  expect(() =>
    registry.register({
      name: 'no_handler',
      description: 'Missing handler',
      inputSchema: { type: 'object' as const },
      timeoutMs: 5000,
      effect: 'observation',
      handler: undefined as any,
    }),
  ).toThrow('Handler');
  expect(() =>
    registry.register({
      name: 'bad_timeout',
      description: 'Bad timeout',
      inputSchema: { type: 'object' as const },
      timeoutMs: 40000,
      effect: 'observation',
      handler: async () => ({}),
    }),
  ).toThrow('Timeout');
});
