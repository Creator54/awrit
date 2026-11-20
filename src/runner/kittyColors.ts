import { OSC } from '../tty/escapeCodes';

function toKebabCase(str: string): string {
  return str
    .replace(/^(\d+)$/, 'c$1')
    .replace(/_color$/, '')
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase();
}

const replacements: Record<string, string> = {
  foreground: 'kitty-fg',
  background: 'kitty-bg',
};

type Color = [name: string, color: string];
type QueryResponse = Array<Color> | undefined;
export function queryColors(): Promise<QueryResponse> {
  const { promise, resolve } = Promise.withResolvers<QueryResponse>();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');

  let color_query = '';
  for (let i = 0; i <= 255; i++) {
    color_query += `;${i}=?`;
  }

  // OSC 21 is Kitty's; a multiplexer such as TUIOS does not pass it through
  // but answers the standard OSC 10/11. The terminal answers in order, so the
  // OSC 11 reply comes last and ends the query either way.
  process.stdout.write(
    OSC`21;foreground=?;background=?;active_border_color=?;selection_background=?;selection_foreground=?;cursor=?;cursor_text=?${color_query}` +
      OSC`10;?` +
      OSC`11;?`,
  );

  const finish = (result: QueryResponse) => {
    clearTimeout(timeout);
    process.stdin.off('data', handler);
    process.stdin.pause();
    process.stdin.setRawMode(false);
    resolve(result);
  };
  let buffer = '';
  const handler = (chunk: string) => {
    buffer += chunk;
    const replies = new Map<string, string>();
    // biome-ignore lint/suspicious/noControlCharactersInRegex: matching OSC replies (ESC ] … BEL or ST)
    for (const [, code, body] of buffer.matchAll(/\x1b\](21|10|11);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
      replies.set(code, body);
    }
    if (!replies.has('11')) return;
    const pairs = (replies.get('21') ?? '').split(';').map((y) => y.split('='));
    pairs.push(['foreground', replies.get('10') ?? ''], ['background', replies.get('11') ?? '']);
    const colors = new Map<string, string>();
    for (const [name_, color] of pairs) {
      const name = replacements[name_] ?? toKebabCase(name_);
      // rgb:r/g/b has 1–4 hex digits per channel (TUIOS answers with 4); CSS takes #rrggbb.
      const channels = color?.match(/^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i)?.slice(1);
      if (channels && !colors.has(name)) colors.set(name, `#${channels.map((c) => c.padEnd(2, c).slice(0, 2)).join('').toLowerCase()}`);
    }
    finish([...colors]);
  };
  process.stdin.on('data', handler);

  const timeout = setTimeout(() => finish(undefined), 100);

  return promise;
}

export function terminalScheme(colors: Color[]): 'light' | 'dark' {
  const background = colors.find(([name]) => name === 'kitty-bg')?.[1];
  const hex = background?.slice(1);
  const channels = hex && [6, 12].includes(hex.length)
    ? [0, 1, 2].map(i => Number.parseInt(hex.slice(i * hex.length / 3, (i + 1) * hex.length / 3), 16) / (hex.length === 12 ? 65535 : 255))
    : null;
  const light = channels?.every(Number.isFinite) && channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722 > 0.5;
  return light ? 'light' : 'dark';
}

/** Kitty background as `#rrggbb`, so Awrit's backing fills match the terminal. */
export function terminalBackground(colors: Color[]): string | undefined {
  const hex = colors.find(([name]) => name === 'kitty-bg')?.[1].slice(1);
  if (!hex || !/^([0-9a-f]{6}|[0-9a-f]{12})$/i.test(hex)) return undefined;
  const step = hex.length / 3;
  return `#${[0, 1, 2].map(i => hex.slice(i * step, i * step + 2)).join('').toLowerCase()}`;
}

export function colorsToTailwind(colors: Color[]) {
  return `@theme {
${colors.map(([name_, color]) => `  --color-${name_}: ${color};`).join('\n')}
}`;
}

// for running directly
if (require.main === module) {
  queryColors().then((x) => {
    if (x) console.log(colorsToTailwind(x));
  });
}
