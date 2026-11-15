/**
 * Agent tools for an Android pane. Names and inputs mirror the web viewer's tools, so an
 * agent that learned one can drive the other. Electron-free so it can be unit tested.
 */

/** Android key names an agent may press, in the same spelling as the web `key` tool. */
const KEYS: Readonly<Record<string, string>> = {
  enter: 'KEYCODE_ENTER',
  tab: 'KEYCODE_TAB',
  space: 'KEYCODE_SPACE',
  escape: 'KEYCODE_BACK',
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  appswitch: 'KEYCODE_APP_SWITCH',
  arrowup: 'KEYCODE_DPAD_UP',
  arrowdown: 'KEYCODE_DPAD_DOWN',
  arrowleft: 'KEYCODE_DPAD_LEFT',
  arrowright: 'KEYCODE_DPAD_RIGHT',
  backspace: 'KEYCODE_DEL',
  delete: 'KEYCODE_FORWARD_DEL',
  pageup: 'KEYCODE_PAGE_UP',
  pagedown: 'KEYCODE_PAGE_DOWN',
  volumeup: 'KEYCODE_VOLUME_UP',
  volumedown: 'KEYCODE_VOLUME_DOWN',
  power: 'KEYCODE_POWER',
};

const MAX_NODES = 200;
const MAX_FIELD = 160;
const MAX_KEYS = 40;
const MAX_TEXT = 256;
const SWIPE_MS = 300;
const MAX_SCROLLS = 10;

export interface AndroidToolDeps {
  /** Sends one validated control request; throws when the device rejects it. */
  post(path: string, body: Record<string, unknown>): Promise<void>;
  /** Returns the raw uiautomator XML of the current screen. */
  dump(): Promise<string>;
  /** Device screen size in pixels. */
  size(): { width: number; height: number };
  /** Launchable `package/activity` components installed on the device. */
  apps(): Promise<string[]>;
  /** Shows the user where the agent is about to act, in device pixels; never throws. */
  preview?(at: { x: number; y: number }, label: string, press: boolean): Promise<void>;
}

/**
 * Picks the launch component for an app name or package. A whole package or its last segment
 * wins over a substring match; several substring matches are ambiguous.
 */
export function matchApp(apps: readonly string[], query: string): string {
  const want = query.trim().toLowerCase().replace(/\s+/g, '');
  if (!want) throw new Error('app must name an app or package');
  const pkg = (component: string) => component.split('/')[0].toLowerCase();
  const exact = apps.filter(
    (c) => pkg(c) === want || c.toLowerCase() === want || pkg(c).split('.').at(-1) === want,
  );
  const found = exact.length > 0 ? exact : apps.filter((c) => pkg(c).includes(want));
  const packages = [...new Set(found.map(pkg))];
  if (packages.length === 1) return found[0];
  const all = packages.length > 0 ? packages : [...new Set(apps.map(pkg))];
  const list = all.slice(0, 6).join(', ');
  const more = all.length > 6 ? ` … and ${all.length - 6} more` : '';
  throw new Error(
    `${packages.length > 0 ? 'Several apps match' : 'No app matches'} ${JSON.stringify(query)}; ` +
      `use a package: ${list}${more}`,
  );
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface AndroidNode {
  ref: string;
  role: string;
  name?: string;
  id?: string;
  states?: string[];
  /** Center of the element in device pixels; what `click` taps. */
  x: number;
  y: number;
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

function unescapeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? Number.parseInt(entity.slice(2), 16)
          : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[entity] ?? match;
  });
}

function clip(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_FIELD ? `${flat.slice(0, MAX_FIELD - 1)}…` : flat;
}

function parseBounds(value: string | undefined): Rect | null {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(value ?? '');
  if (!match) return null;
  const [left, top, right, bottom] = match.slice(1).map(Number);
  return right > left && bottom > top ? { left, top, right, bottom } : null;
}

/**
 * Turns a uiautomator dump into the elements an agent can act on: anything with text or a
 * description, or that responds to touch. Layout-only containers are dropped.
 */
export function parseUiDump(
  xml: string,
  snapshotId: string,
  screen: { width: number; height: number },
): { nodes: AndroidNode[]; truncated: boolean } {
  const nodes: AndroidNode[] = [];
  let truncated = false;
  for (const tag of xml.matchAll(/<node\b([^>]*)>/g)) {
    const attrs: Record<string, string> = {};
    for (const attr of tag[1].matchAll(/([\w-]+)="([^"]*)"/g)) {
      attrs[attr[1]] = unescapeXml(attr[2]);
    }
    const rect = parseBounds(attrs.bounds);
    if (!rect) continue;
    // Off-screen elements cannot be tapped.
    const x = Math.round((Math.max(rect.left, 0) + Math.min(rect.right, screen.width)) / 2);
    const y = Math.round((Math.max(rect.top, 0) + Math.min(rect.bottom, screen.height)) / 2);
    if (x <= 0 || y <= 0 || x >= screen.width || y >= screen.height) continue;
    const name = clip(attrs.text || attrs['content-desc'] || '');
    const role = (attrs.class ?? '').split('.').pop() || 'View';
    const editable = role.includes('EditText');
    const states = [
      attrs.clickable === 'true' && 'clickable',
      attrs['long-clickable'] === 'true' && 'long-clickable',
      attrs.scrollable === 'true' && 'scrollable',
      editable && 'editable',
      attrs.checkable === 'true' && (attrs.checked === 'true' ? 'checked' : 'unchecked'),
      attrs.selected === 'true' && 'selected',
      attrs.focused === 'true' && 'focused',
      attrs.enabled === 'false' && 'disabled',
      attrs.password === 'true' && 'password',
    ].filter((state): state is string => typeof state === 'string');
    const acts = states.some((s) => s === 'clickable' || s === 'scrollable' || s === 'editable');
    if (!name && !acts) continue;
    if (nodes.length >= MAX_NODES) {
      truncated = true;
      break;
    }
    const id = attrs['resource-id']?.split(':id/').pop();
    nodes.push({
      ref: `${snapshotId}:e${nodes.length + 1}`,
      role,
      ...(name ? { name } : {}),
      ...(id ? { id: clip(id) } : {}),
      ...(states.length ? { states } : {}),
      x,
      y,
    });
  }
  return { nodes, truncated };
}

export interface AndroidToolMetadata {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  effect: 'observation' | 'mutation';
}

const POINT = {
  ref: { type: 'string', description: 'Element ref from the latest snapshot' },
  x: { type: 'number', description: 'Device pixel x' },
  y: { type: 'number', description: 'Device pixel y' },
};

export const ANDROID_TOOLS: readonly AndroidToolMetadata[] = [
  {
    name: 'snapshot',
    description:
      'List on-screen Android elements with roles, names, states and refs for click/type. ' +
      'Refs expire after any action. Games and some apps expose no elements; then use a ' +
      'capture and click by x/y.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 200, description: 'Only elements matching this text' },
      },
    },
    effect: 'observation',
  },
  {
    name: 'click',
    description: 'Tap an element by ref, or a point by device pixel x/y.',
    inputSchema: { type: 'object', properties: POINT },
    effect: 'mutation',
  },
  {
    name: 'type',
    description: 'Type 1-256 printable ASCII characters, after tapping ref when given.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, ref: POINT.ref },
      required: ['text'],
    },
    effect: 'mutation',
  },
  {
    name: 'key',
    description: `Press one key or a list of keys: ${Object.keys(KEYS).join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        keys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_KEYS },
      },
    },
    effect: 'mutation',
  },
  {
    name: 'open',
    description:
      'Open an installed app by name or package, e.g. Settings or com.android.chrome. ' +
      'An unknown name lists the apps.',
    inputSchema: {
      type: 'object',
      properties: { app: { type: 'string', minLength: 1, maxLength: 200 } },
      required: ['app'],
    },
    effect: 'mutation',
  },
  {
    name: 'scroll',
    description:
      'Swipe to scroll content up/down/left/right, inside ref or at x/y, else the screen center. ' +
      `With until, keep scrolling (at most ${MAX_SCROLLS} swipes) until an element matching that ` +
      'text is on screen and return it with fresh refs, or report the end of the content.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] },
        until: { type: 'string', minLength: 1, maxLength: 200, description: 'Text to scroll to' },
        ...POINT,
      },
      required: ['direction'],
    },
    effect: 'mutation',
  },
];

function record(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object input');
  return value as Record<string, unknown>;
}

function optionalString(input: Record<string, unknown>, field: string): string | undefined {
  const value = input[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  return value;
}

export interface AndroidTools {
  call(name: string, params: unknown): Promise<unknown>;
  list(): readonly AndroidToolMetadata[];
}

export function createAndroidTools(deps: AndroidToolDeps): AndroidTools {
  let snapshotCount = 0;
  // Refs of the latest snapshot; any action clears them because the screen may change.
  let refs = new Map<string, AndroidNode>();

  function point(input: Record<string, unknown>): { x: number; y: number } {
    const ref = optionalString(input, 'ref');
    if (ref !== undefined) {
      const node = refs.get(ref);
      if (!node) throw new Error('Unknown or expired ref; take a new snapshot');
      return { x: node.x, y: node.y };
    }
    const { x, y } = input;
    if (x === undefined && y === undefined) throw new Error('Give ref or x and y');
    const size = deps.size();
    if (
      typeof x !== 'number' ||
      typeof y !== 'number' ||
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x >= size.width ||
      y >= size.height
    ) {
      throw new Error(`x and y must be inside the ${size.width}x${size.height} screen`);
    }
    return { x: Math.round(x), y: Math.round(y) };
  }

  function queryOf(input: Record<string, unknown>, field: string): string | undefined {
    const query = optionalString(input, field)?.trim().toLowerCase();
    if (query && query.length > 200) throw new Error(`${field} is too long`);
    return query || undefined;
  }

  async function snapshot(input: Record<string, unknown>) {
    return (await observe(queryOf(input, 'query'))).result;
  }

  async function observe(query: string | undefined) {
    refs = new Map();
    const xml = await deps.dump().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(
        `${detail}. The device cannot list elements on this screen right now; capture the screen and click by x/y`,
      );
    });
    const size = deps.size();
    snapshotCount += 1;
    const parsed = parseUiDump(xml, `a${snapshotCount}`, size);
    refs = new Map(parsed.nodes.map((node) => [node.ref, node]));
    const nodes = query
      ? parsed.nodes.filter((node) =>
          [node.name ?? '', node.id ?? '', node.role].some((field) =>
            field.toLowerCase().includes(query),
          ),
        )
      : parsed.nodes;
    return {
      xml,
      result: {
        ok: true,
        screen: size,
        nodes,
        ...(parsed.truncated ? { truncated: true } : {}),
        ...(parsed.nodes.length === 0
          ? { note: 'No elements exposed; capture the screen and click by x/y' }
          : {}),
      },
    };
  }

  function center() {
    const size = deps.size();
    return { x: Math.round(size.width / 2), y: Math.round(size.height / 2) };
  }

  async function show(at: { x: number; y: number }, label: string, press: boolean) {
    await deps.preview?.(at, label, press).catch(() => undefined);
  }

  async function act(name: string, input: Record<string, unknown>) {
    switch (name) {
      case 'click': {
        const at = point(input);
        refs = new Map();
        await show(at, 'tap', true);
        await deps.post('/tap', at);
        return { ok: true, ...at };
      }
      case 'type': {
        const text = input.text;
        if (
          typeof text !== 'string' ||
          !text ||
          text.length > MAX_TEXT ||
          /[^\x20-\x7e]/.test(text)
        ) {
          throw new Error('text must be 1-256 printable ASCII characters');
        }
        const at = input.ref === undefined ? null : point(input);
        refs = new Map();
        await show(at ?? center(), 'type', at !== null);
        if (at) await deps.post('/tap', at);
        await deps.post('/text', { text });
        return { ok: true, typed: text.length };
      }
      case 'key': {
        const names =
          input.keys !== undefined ? input.keys : input.key !== undefined ? [input.key] : undefined;
        if (!Array.isArray(names) || names.length === 0 || names.length > MAX_KEYS) {
          throw new Error(`Give key or 1-${MAX_KEYS} keys`);
        }
        const codes = names.map((key) => {
          const code =
            typeof key === 'string' ? KEYS[key.toLowerCase().replace(/[\s_-]/g, '')] : undefined;
          if (!code) throw new Error(`Unknown key ${String(key)}; use type for text`);
          return code;
        });
        refs = new Map();
        const size = deps.size();
        await show(
          { x: Math.round(size.width / 2), y: size.height - 40 },
          `press ${names.map(String).join(', ').toLowerCase()}`.slice(0, 40),
          true,
        );
        for (const keycode of codes) await deps.post('/key', { keycode });
        return { ok: true, pressed: codes.length };
      }
      case 'open': {
        if (typeof input.app !== 'string') throw new Error('app must name an app or package');
        const component = matchApp(await deps.apps(), input.app);
        refs = new Map();
        await show(center(), `open ${component.split('/')[0]}`, false);
        await deps.post('/launch', { component });
        return { ok: true, opened: component };
      }
      case 'scroll': {
        const direction = input.direction;
        if (
          direction !== 'up' &&
          direction !== 'down' &&
          direction !== 'left' &&
          direction !== 'right'
        ) {
          throw new Error('direction must be up, down, left or right');
        }
        const until = queryOf(input, 'until');
        const size = deps.size();
        const anchor =
          input.ref === undefined && input.x === undefined && input.y === undefined
            ? center()
            : point(input);
        // Scrolling down moves content up, so the finger travels against the direction.
        // The swipe keeps its length and slides inward when the point is near an edge.
        const sweep = (at: number, length: number, sign: number) => {
          const half = Math.round(length * 0.15);
          const middle = Math.max(half, Math.min(length - 1 - half, at));
          return [middle - sign * half, middle + sign * half];
        };
        const vertical = direction === 'up' || direction === 'down';
        const sign = direction === 'down' || direction === 'right' ? -1 : 1;
        const [x1, x2] = vertical ? [anchor.x, anchor.x] : sweep(anchor.x, size.width, sign);
        const [y1, y2] = vertical ? sweep(anchor.y, size.height, sign) : [anchor.y, anchor.y];
        refs = new Map();
        if (!until) {
          await show(anchor, `scroll ${direction}`, false);
          await deps.post('/swipe', { x1, y1, x2, y2, ms: SWIPE_MS });
          return { ok: true, direction };
        }
        let seen = await observe(until);
        for (let swipes = 0; seen.result.nodes.length === 0; swipes += 1) {
          if (swipes === MAX_SCROLLS) return { ...seen.result, found: false, swipes };
          await show(anchor, `scroll ${direction} to ${until}`.slice(0, 40), false);
          await deps.post('/swipe', { x1, y1, x2, y2, ms: SWIPE_MS });
          const before = seen.xml;
          seen = await observe(until);
          // An unchanged screen means the content cannot scroll further this way.
          if (seen.result.nodes.length === 0 && seen.xml === before) {
            return { ...seen.result, found: false, end: true, swipes: swipes + 1 };
          }
        }
        return { ...seen.result, found: true };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  // One call at a time: the device has one screen, one dump file and one finger.
  let queue: Promise<unknown> = Promise.resolve();
  return {
    call(name, params) {
      const run = queue.then((): Promise<unknown> => {
        const input = record(params);
        return name === 'snapshot' ? snapshot(input) : act(name, input);
      });
      queue = run.catch(() => undefined);
      return run;
    },
    list: () => ANDROID_TOOLS,
  };
}

/** Android tools over an ADB control server; `request` sends to a path on that server. */
export function createAndroidHttpTools(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  size: AndroidToolDeps['size'],
  preview?: AndroidToolDeps['preview'],
): AndroidTools {
  const checked = async (path: string, init?: RequestInit) => {
    const response = await request(path, init);
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).trim().slice(0, 300);
      throw new Error(
        `Android device refused ${path} (${response.status})${detail ? `: ${detail}` : ''}`,
      );
    }
    return response;
  };
  return createAndroidTools({
    size,
    preview,
    dump: async () => (await checked('/ui')).text(),
    apps: async () => {
      const { apps } = (await (await checked('/apps')).json()) as { apps?: unknown };
      return Array.isArray(apps)
        ? apps.filter((app): app is string => typeof app === 'string')
        : [];
    },
    post: async (path, body) => {
      await checked(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    },
  });
}
