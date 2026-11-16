import {
  BROWSING_PREFERENCES,
  type BrowsingPreference,
  HARNESSES,
  type Harness,
} from './contextGuidance';
import { UsageError } from './usageError';

export const PRESENTATION_COMMANDS = [
  'capabilities',
  'inline',
  'show',
  'snapshot',
  'setup',
  'context',
  'overlay',
  'capture',
  'video',
] as const;
export type PresentationCommand = (typeof PRESENTATION_COMMANDS)[number];
export const PRESENTATION_MODES = [
  'auto',
  'inline',
  'split',
  'tab',
  'overlay',
  'window',
  'companion',
] as const;
export type PresentationMode = (typeof PRESENTATION_MODES)[number];

export type PresentationLayout = 'text-left' | 'media-left';

export interface ColumnSplit {
  text: number;
  media: number;
}

export interface PresentationArgs {
  command: PresentationCommand;
  target?: string;
  mode: PresentationMode;
  text?: string;
  columns?: ColumnSplit;
  layout?: PresentationLayout;
  width?: number;
  height?: number;
  viewport?: { width: number; height: number };
  out?: string;
  json: boolean;
  help: boolean;
  overwrite: boolean;
  dryRun: boolean;
  claude: boolean;
  uninstall: boolean;
  /** With --uninstall: also delete Awrit's saved data. */
  purge: boolean;
  yes: boolean;
  close?: boolean;
  status?: boolean;
  comment?: string;
  region?: string;
  waitMs?: number;
  waitSelector?: string;
  harness?: Harness;
  browsing?: BrowsingPreference;
  /** Remote viewer host; only `show` uses it. */
  host?: string;
  /** Path of the awrit runtime on the remote host; skips the probe and install. */
  remoteAwrit?: string;
  /** Local loopback port to forward to the remote host; only `show` uses it. */
  forward?: number;
  /** Remote page left by Disconnect; only `show --host` uses it. */
  session?: string;
}

export function isPresentationCommand(value: string | undefined): value is PresentationCommand {
  return PRESENTATION_COMMANDS.some((command) => command === value);
}

export function parsePresentationArgs(argv: string[]): PresentationArgs | null {
  try {
    return parsePresentationArgsUnchecked(argv);
  } catch (error) {
    // Every rejection here is argument misuse, so the caller exits 2.
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

function parsePresentationArgsUnchecked(argv: string[]): PresentationArgs | null {
  if (!isPresentationCommand(argv[0])) return null;
  const result: PresentationArgs = {
    command: argv[0],
    mode: argv[0] === 'overlay' ? 'overlay' : 'auto',
    json: false,
    help: false,
    overwrite: false,
    dryRun: false,
    claude: false,
    uninstall: false,
    purge: false,
    yes: false,
  };
  const suppliedOptions = new Set<string>();
  let positionalOnly = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--' && !positionalOnly) {
      positionalOnly = true;
      continue;
    }
    if (!arg.startsWith('-') || positionalOnly) {
      if (result.command === 'overlay' && arg === 'close') {
        result.close = true;
        continue;
      }
      if (result.command === 'overlay' && arg === 'status') {
        result.status = true;
        continue;
      }
      if (result.target !== undefined) throw new Error('Specify only one presentation target');
      result.target = arg;
      continue;
    }
    const split = arg.indexOf('=');
    const key = split === -1 ? arg : arg.slice(0, split);
    const inlineValue = split === -1 ? undefined : arg.slice(split + 1);
    if (suppliedOptions.has(key)) throw new Error(`Specify ${key} only once.`);
    suppliedOptions.add(key);
    const booleans: Record<
      string,
      'json' | 'help' | 'overwrite' | 'dryRun' | 'claude' | 'uninstall' | 'purge' | 'yes'
    > = {
      '--json': 'json',
      '--help': 'help',
      '-h': 'help',
      '--overwrite': 'overwrite',
      '--dry-run': 'dryRun',
      '--claude': 'claude',
      '--uninstall': 'uninstall',
      '--purge': 'purge',
      '--yes': 'yes',
    };
    if (Object.hasOwn(booleans, key)) {
      if (inlineValue !== undefined) throw new Error(`${key} does not take a value`);
      result[booleans[key]] = true;
      continue;
    }
    if (
      ![
        '--mode',
        '--width',
        '--height',
        '--out',
        '--viewport',
        '--text',
        '--columns',
        '--layout',
        '--comment',
        '--region',
        '--wait-ms',
        '--wait-selector',
        '--harness',
        '--browsing',
        '--host',
        '--remote-awrit',
        '--forward',
        '--session',
      ].includes(key)
    ) {
      throw new Error(`Unknown presentation option: ${key}`);
    }
    const value = inlineValue ?? argv[++i];
    if (!value || (inlineValue === undefined && value.startsWith('-'))) {
      throw new Error(`${key} requires a value`);
    }
    if (key === '--out') result.out = value;
    else if (key === '--comment') result.comment = value;
    else if (key === '--region') result.region = value;
    else if (key === '--host') result.host = value;
    else if (key === '--remote-awrit') result.remoteAwrit = value;
    else if (key === '--session') {
      // Same shape the owner accepts, so a typo fails before any SSH work.
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(value))
        throw new Error('--session is not a valid session id');
      result.session = value;
    } else if (key === '--wait-selector') result.waitSelector = value;
    else if (key === '--forward') {
      if (!/^\d{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
        throw new Error('--forward must be an integer from 1 to 65535');
      }
      result.forward = Number(value);
    } else if (key === '--wait-ms') {
      const ms = Number(value);
      if (!Number.isSafeInteger(ms) || ms < 0 || ms > 60000) {
        throw new Error('--wait-ms must be a non-negative integer up to 60000');
      }
      result.waitMs = ms;
    } else if (key === '--harness') {
      if (!HARNESSES.includes(value as Harness)) {
        throw new Error(`--harness must be one of ${HARNESSES.join(', ')}`);
      }
      result.harness = value as Harness;
    } else if (key === '--browsing') {
      if (!BROWSING_PREFERENCES.includes(value as BrowsingPreference)) {
        throw new Error(`--browsing must be one of ${BROWSING_PREFERENCES.join(', ')}`);
      }
      result.browsing = value as BrowsingPreference;
    } else if (key === '--text') {
      if (Buffer.byteLength(value, 'utf8') > 65536) {
        throw new Error('--text exceeds the 64 KiB limit');
      }
      // biome-ignore lint/suspicious/noControlCharactersInRegex: reject terminal control characters
      if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(value)) {
        throw new Error('--text contains invalid control characters');
      }
      result.text = value;
    } else if (key === '--layout') {
      if (value !== 'text-left' && value !== 'media-left') {
        throw new Error("--layout must be 'text-left' or 'media-left'");
      }
      result.layout = value;
    } else if (key === '--columns') {
      const match = /^(\d+):(\d+)$/.exec(value);
      if (!match) throw new Error('--columns must be TEXT:MEDIA (e.g. 40:40)');
      const textCols = Number(match[1]);
      const mediaCols = Number(match[2]);
      if (
        !Number.isSafeInteger(textCols) ||
        !Number.isSafeInteger(mediaCols) ||
        textCols < 1 ||
        mediaCols < 1 ||
        textCols > 1000 ||
        mediaCols > 1000
      ) {
        throw new Error('--columns values must be integers between 1 and 1000');
      }
      result.columns = { text: textCols, media: mediaCols };
    } else if (key === '--mode') {
      if (!PRESENTATION_MODES.includes(value as PresentationMode)) {
        throw new Error(`Invalid --mode. Use: ${PRESENTATION_MODES.join(', ')}`);
      }
      result.mode = value as PresentationMode;
    } else if (key === '--viewport') {
      const match = /^(\d+)x(\d+)$/.exec(value);
      if (!match) throw new Error('--viewport must be WIDTHxHEIGHT');
      const width = Number(match[1]);
      const height = Number(match[2]);
      if (width < 1 || height < 1 || width > 4096 || height > 4096 || width * height > 8_388_608) {
        throw new Error('Viewport exceeds the 4096-side / 8-megapixel limit');
      }
      result.viewport = { width, height };
    } else {
      const cells = Number(value);
      if (!/^\d+$/.test(value) || !Number.isSafeInteger(cells) || cells < 1 || cells > 1000) {
        throw new Error(`${key} must be an integer from 1 to 1000 cells`);
      }
      if (key === '--width') result.width = cells;
      else result.height = cells;
    }
  }
  if (result.help) return result;
  if (result.command === 'overlay') {
    if (result.close && result.status) throw new Error('Use either close or status');
    if (
      (result.close || result.status) &&
      (result.target !== undefined)
    ) {
      throw new Error('Cannot specify a target with close or status');
    }
    if (result.text !== undefined) {
      if (result.close || result.status || result.target !== undefined)
        throw new Error(
          'overlay --text updates the open video overlay; give no target, close or status',
        );
    }
  }
  if (result.command === 'video' && !result.target)
    throw new Error('video requires a local recording path');
  if (result.target !== undefined && !result.target) throw new Error('Target must not be empty');
  if (result.command === 'inline' || result.command === 'show') {
    if (!result.target) throw new Error('A target is required');
  }
  if (result.command === 'snapshot' && (!result.target || !result.out)) {
    throw new Error('snapshot requires TARGET and --out');
  }
  if (result.command === 'capabilities' && result.target)
    throw new Error('capabilities takes no target');
  if (result.command === 'context' && result.target)
    throw new Error('context takes no target');
  const allowed: Record<PresentationCommand, string[]> = {
    capabilities: [],
    context: ['--claude', '--harness', '--browsing'],
    inline: ['--width', '--height', '--text', '--columns', '--layout'],
    show: [
      '--mode',
      '--width',
      '--height',
      '--text',
      '--columns',
      '--layout',
      '--host',
      '--remote-awrit',
      '--forward',
      '--session',
    ],
    snapshot: ['--out', '--viewport', '--overwrite', '--wait-ms', '--wait-selector'],
    setup: ['--dry-run', '--claude', '--uninstall', '--purge', '--yes', '--browsing'],
    overlay: ['--text'],
    capture: ['--comment', '--region', '--wait-ms', '--wait-selector'],
    video: ['--mode', '--text'],
  };
  for (const key of suppliedOptions) {
    if (!['--json', '--help', '-h'].includes(key) && !allowed[result.command].includes(key)) {
      throw new Error(`${key} is not supported by ${result.command}`);
    }
  }
  if (result.command === 'video') {
    if (result.mode !== 'auto' && result.mode !== 'overlay')
      throw new Error('video supports only --mode overlay');
    if (result.text && result.mode !== 'overlay')
      throw new Error('video --text requires --mode overlay');
  }
  if (result.remoteAwrit !== undefined && result.host === undefined)
    throw new Error('--remote-awrit requires --host');
  if (result.forward !== undefined && result.host === undefined)
    throw new Error('--forward requires --host');
  if (result.session !== undefined && result.host === undefined)
    throw new Error('--session requires --host');
  if (result.session !== undefined && result.forward !== undefined)
    throw new Error('--session cannot be used with --forward');
  if (result.host !== undefined) {
    // Matches the owner's pageUrl check, so the user gets a reason before any SSH work.
    if (!/^https?:\/\//i.test(result.target ?? ''))
      throw new Error('--host opens http:// or https:// pages only');
    if (
      result.json ||
      result.mode !== 'auto' ||
      result.text !== undefined ||
      result.columns !== undefined ||
      result.layout !== undefined
    )
      throw new Error(
        '--host draws the page in this pane; drop --json, --mode, --text and layout options',
      );
  }
  if ((result.columns || result.layout || result.mode === 'companion') && !result.text)
    throw new Error('Same-pane layout options require --text');
  if (result.text && result.width !== undefined)
    throw new Error('Use --columns instead of --width with --text');
  if (
    result.text &&
    result.command === 'show' &&
    result.height !== undefined &&
    result.mode !== 'inline'
  )
    throw new Error('--height with --text is only supported for inline output');
  if (result.command === 'inline' && result.json)
    throw new Error('inline graphics cannot use --json');
  if (
    result.command === 'setup' &&
    result.target &&
    !['kitty', 'agents', 'plugins'].includes(result.target)
  ) {
    throw new Error('setup takes no target, or kitty, agents or plugins');
  }
  if (result.purge && (!result.uninstall || result.target !== undefined))
    throw new Error('--purge works only with full setup --uninstall');
  if (result.browsing && result.target !== undefined && result.target !== 'agents')
    throw new Error('--browsing applies only to full setup or setup agents');
  if (result.yes && result.target !== undefined && result.target !== 'plugins')
    throw new Error('--yes is only for setup or setup plugins');
  return result;
}
