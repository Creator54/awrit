import type { WebContents } from 'electron';

export interface ToolSchema {
  type: 'object' | 'array' | 'string' | 'number' | 'boolean' | 'null';
  properties?: Record<string, unknown>;
  required?: string[];
  items?: unknown;
  [key: string]: unknown;
}

function jsType(value: unknown): string {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}

export interface ToolContext {
  webContents: WebContents;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  timeoutMs: number;
  effect: 'observation' | 'mutation';
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolMetadata {
  name: string;
  description: string;
  inputSchema: ToolSchema;
  timeoutMs: number;
  effect: 'observation' | 'mutation';
}

export interface ToolRegistry {
  register(def: ToolDefinition): void;
  get(name: string): ToolDefinition;
  validate(name: string, input: unknown): Promise<unknown>;
  listTools(): ToolMetadata[];
}

export function createRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();

  return {
    register(def: ToolDefinition) {
      if (!def.name || typeof def.name !== 'string') throw new Error('Tool name required');
      if (tools.has(def.name)) throw new Error(`Tool ${def.name} already registered`);
      if (!def.handler || typeof def.handler !== 'function') throw new Error('Handler required');
      if (!Number.isInteger(def.timeoutMs) || def.timeoutMs <= 0 || def.timeoutMs > 30000)
        throw new Error('Timeout must be 1–30000 ms');
      if (!['observation', 'mutation'].includes(def.effect)) throw new Error('Invalid effect');
      tools.set(def.name, def);
    },
    get(name: string) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`Unknown tool: ${name}`);
      return tool;
    },
    async validate(name: string, input: unknown) {
      const def = this.get(name);
      if (def.inputSchema.type === 'object') {
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Expected object input');
      }
      const inputObj = (input ?? {}) as Record<string, unknown>;
      const props = (def.inputSchema.properties ?? {}) as Record<string, { type?: string }>;
      for (const field of def.inputSchema.required ?? []) {
        if (inputObj[field] === undefined) throw new Error(`Missing required field: ${field}`);
      }
      for (const [field, schema] of Object.entries(props)) {
        const value = inputObj[field];
        if (value !== undefined && schema.type && jsType(value) !== schema.type)
          throw new Error(`Expected ${schema.type} for ${field}`);
      }
      return input;
    },
    listTools() {
      return Array.from(tools.values()).map(({ name, description, inputSchema, timeoutMs, effect }) => ({
        name,
        description,
        inputSchema,
        timeoutMs,
        effect,
      }));
    },
  };
}
