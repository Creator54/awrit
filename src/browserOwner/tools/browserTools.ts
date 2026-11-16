import { createRegistry, type ToolDefinition, type ToolRegistry, type ToolSchema } from './registry';
import { captureAccessibility } from './accessibility';
import { clipField, readPageText } from './text';
import { performClick } from './click';
import { performType } from './type';
import { performNavigate } from './navigate';
import { performKey } from './key';
import { performScroll } from './scroll';
import { performWait } from './wait';
import { readConsoleLog, type ConsoleInput } from './console';
import { readNetworkLog, type NetworkInput } from './network';
import { readPageState } from './page';
import { evaluateInPage } from './evaluate';
import { showAreaPreview } from './preview';

// Inputs are checked against each tool's inputSchema by the dispatcher before a handler runs,
// so the casts below rely on that validation.
const emptyObject: ToolSchema = { type: 'object' as const };

export function createBrowserToolRegistry(): ToolRegistry {
  const registry = createRegistry();
  const register = (definition: ToolDefinition) => {
    const handler = definition.handler;
    registry.register({
      ...definition,
      handler: definition.effect === 'mutation' ? async (input, context) => {
        const action = (await handler(input, context)) as Record<string, unknown>;
        const wc = context.webContents;
        // A full tree after every action costs agents ~25 KB a step, so only failures get one,
        // for recovery. Successful actions report where the page is; agents snapshot for refs.
        // Navigate already reports url and title.
        if (action.ok === true && 'url' in action) return action;
        if (action.ok === true) return { ...action, page: { url: clipField(wc.getURL()), title: clipField(wc.getTitle()) } };
        return { ...action, observation: await captureAccessibility(wc) };
      } : handler,
    });
  };

  register({
    name: 'snapshot',
    description: 'Read Chromium accessibility roles, names and states with document-scoped refs for click/type. Pass query to get only nodes whose role or name contains it (case-insensitive). Canvas content may require a screenshot.',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 200 } },
      additionalProperties: false,
    },
    timeoutMs: 5000,
    effect: 'observation',
    handler: async (input, { webContents: wc }) => {
      const query = (input as { query?: string }).query?.trim() || undefined;
      void showAreaPreview(wc, 'viewport', query ? `finding "${query}"` : 'reading page structure');
      const observation = await captureAccessibility(wc, query);
      return { ok: observation.status === 'captured', observation };
    },
  });

  register({
    name: 'text',
    description: 'Read the page as plain text, as a person sees it. Use it to read content; use snapshot for accessibility refs.',
    inputSchema: emptyObject,
    timeoutMs: 5000,
    effect: 'observation',
    handler: async (_input, { webContents: wc }) => {
      void showAreaPreview(wc, 'viewport', 'reading page text');
      return { ok: true, url: clipField(wc.getURL()), title: clipField(wc.getTitle()), ...(await readPageText(wc)) };
    },
  });

  register({
    name: 'click',
    description: 'Click an accessibility ref from the latest snapshot, a CSS selector, or x/y. Returns the action result and page URL/title; a failed click also returns a fresh accessibility observation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string' },
        ref: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
    },
    timeoutMs: 3000,
    effect: 'mutation',
    handler: async (input, { webContents: wc }) => {
      // previewMs is not passed on: agents cannot change the preview time.
      const { selector, ref, x, y } = input as Parameters<typeof performClick>[1];
      return performClick(wc, { selector, ref, x, y });
    },
  });

  register({
    name: 'type',
    description: 'Replace text in an input or textarea by accessibility ref, CSS selector, or focus. With no target and no focused text field (canvas apps), sends the text as key presses, up to 40 characters. Returns the action result and page URL/title; a failed type also returns a fresh accessibility observation.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        text: { type: 'string' },
        selector: { type: 'string' },
        ref: { type: 'string' },
      },
      required: ['text'],
    },
    timeoutMs: 3000,
    effect: 'mutation',
    handler: async (input, { webContents: wc }) => {
      const { text, selector, ref } = input as Parameters<typeof performType>[1];
      return performType(wc, { text, selector, ref });
    },
  });

  register({
    name: 'key',
    description: 'Press a key or key combination (e.g. Enter, Escape, ArrowDown, Tab, or key with modifiers), or up to 40 keys in order with keys: ["x","Enter"]. Essential for canvas, WebGPU and shortcut-driven apps.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 40 },
        modifiers: {
          type: 'array',
          items: { type: 'string', enum: ['alt', 'control', 'meta', 'shift'] },
        },
      },
    },
    timeoutMs: 3000,
    effect: 'mutation',
    handler: async (input, { webContents: wc }) => {
      return performKey(wc, input as Parameters<typeof performKey>[1]);
    },
  });

  register({
    name: 'scroll',
    description: 'Scroll the page, or the contents of the element given by selector. Use direction (up, down, left, right) or x and y. Returns the new position.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
        direction: { type: 'string' },
      },
    },
    timeoutMs: 3000,
    effect: 'mutation',
    handler: async (input, { webContents: wc }) => {
      const { selector, x, y, direction } = input as Parameters<typeof performScroll>[1];
      return performScroll(wc, { selector, x, y, direction });
    },
  });

  register({
    name: 'navigate',
    description: 'Open a URL (http, https or file) in the current page.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    },
    timeoutMs: 10000,
    effect: 'mutation',
    handler: async (input, { webContents: wc }) => {
      return performNavigate(wc, input as Parameters<typeof performNavigate>[1]);
    },
  });

  register({
    name: 'wait',
    description: 'Wait for a selector to appear (or disappear with visible:false), up to timeoutMs (default 5000, max 8000). Or pause for ms (max 8000).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        selector: { type: 'string' },
        visible: { type: 'boolean' },
        ms: { type: 'number' },
        timeoutMs: { type: 'number' },
      },
    },
    timeoutMs: 10000,
    effect: 'observation',
    handler: async (input, { webContents: wc }) => {
      return performWait(wc, input as Parameters<typeof performWait>[1]);
    },
  });

  register({
    name: 'console',
    description: 'Read recent console messages, page errors, failed loads and renderer crashes for this page, oldest first. Recorded from page creation, so the load is included. Use it to debug why a page misbehaves.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        level: { type: 'string', enum: ['debug', 'info', 'warning', 'error'] },
        limit: { type: 'number' },
      },
    },
    timeoutMs: 3000,
    effect: 'observation',
    handler: async (input, { webContents: wc }) => {
      void showAreaPreview(wc, 'viewport', 'checking console');
      return readConsoleLog(wc, input as ConsoleInput);
    },
  });

  register({
    name: 'network',
    description: 'Read recent requests for this page with status or network error, type, cache hit and duration. Response bodies are not recorded: use evaluate with fetch if the body matters.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        failedOnly: { type: 'boolean' },
        urlContains: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    timeoutMs: 3000,
    effect: 'observation',
    handler: async (input, { webContents: wc }) => {
      void showAreaPreview(wc, 'viewport', 'checking network');
      return readNetworkLog(wc, input as NetworkInput);
    },
  });

  register({
    name: 'page',
    description: 'Read page state: URL, title, loading, document HTTP status, viewport size, zoom, device pixel ratio, history and crash.',
    inputSchema: emptyObject,
    timeoutMs: 3000,
    effect: 'observation',
    handler: async (_input, { webContents: wc }) => readPageState(wc),
  });

  // Registered directly, not through register(), so the reply is just the expression's value.
  registry.register({
    name: 'evaluate',
    description: 'Run one JavaScript expression in the page and return its value as JSON. Promises are awaited. Bounded in length and output; a thrown page error comes back as error.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        expression: { type: 'string' },
      },
      required: ['expression'],
    },
    timeoutMs: 5000,
    effect: 'mutation',
    handler: async (input, { webContents: wc }) => {
      void showAreaPreview(wc, 'viewport', 'running script');
      return evaluateInPage(wc, (input as { expression?: unknown }).expression);
    },
  });

  return registry;
}
