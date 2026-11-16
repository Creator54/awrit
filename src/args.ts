import { statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOOPBACK_ADDRESS } from './loopback';

export const rawArgs = process.argv.slice(2);

export const possibleOptions = {
  overlay: {
    short: undefined,
    description: 'Launch viewer in overlay mode (Escape dismisses overlay)',
  },
  'presentation-json': {
    short: undefined,
    description: 'Internal same-pane presentation configuration',
    string: true,
    arg: 'JSON',
  },
  url: { short: undefined, description: 'Set the initial URL', string: true, arg: true },

  help: { short: 'h', description: 'Show help' },
  pick: { short: undefined, description: 'Choose a browser or Android action' },
  version: { short: 'v', description: 'Show version' },
  dev: { short: undefined, description: 'Run in development mode' },
  'no-paint': { short: undefined, description: 'Disable painting' },
  transparent: { short: undefined, description: 'Make the window transparent' },
  'debug-paint': { short: undefined, description: 'Show paint debugging' },
  rebuild: { short: undefined, description: 'Rebuild the toolbar' },
  design: { short: undefined, description: 'Annotate the page for an agent' },
  host: {
    short: undefined,
    description: 'Remote host for show or device view',
    string: true,
    arg: 'HOST',
  },
  session: {
    short: undefined,
    description: 'Reattach a remote session',
    string: true,
    arg: 'ID',
  },
  'remote-awrit': {
    short: undefined,
    description: 'Existing remote Awrit executable',
    string: true,
    arg: 'PATH',
  },
  port: {
    short: undefined,
    description: 'ADB port for a new VM',
    string: true,
    arg: 'PORT',
  },
  image: {
    short: undefined,
    description: 'Image for a new VM',
    string: true,
    arg: 'IMAGE',
  },
  api: {
    short: undefined,
    description: 'Android version for a new VM; default: pinned 13',
    string: true,
    arg: 'API',
  },
  device: {
    short: undefined,
    description: 'Emulated phone model',
    string: true,
    arg: 'DEVICE',
  },
  'max-size': {
    short: undefined,
    description: 'Stream limit in pixels; default: fit terminal',
    string: true,
    arg: 'MAX_SIZE',
  },
  bitrate: {
    short: undefined,
    description: 'Stream bitrate (e.g. 4M)',
    string: true,
    arg: 'BITRATE',
  },
  force: {
    short: undefined,
    description: 'Start with less than 2 GB of free memory, or delete a running device',
  },
  yes: {
    short: undefined,
    description: 'Confirm a destructive device command such as prune',
  },
  resolution: {
    short: undefined,
    description: 'Screen size and optional density',
    string: true,
    arg: 'WIDTHxHEIGHT[@DPI]',
  },
  out: {
    short: undefined,
    description: 'Output file path (e.g. screenshot.png)',
    string: true,
    arg: 'FILE',
  },
  'accept-license': {
    short: undefined,
    description: 'Accept the Android SDK license when building the emulator image',
  },
  'tools-url': {
    short: undefined,
    description: 'Android SDK tools ZIP URL (HTTPS)',
    string: true,
    arg: 'URL',
  },
  'tools-sha256': {
    short: undefined,
    description: 'SHA-256 of the SDK tools ZIP',
    string: true,
    arg: 'SHA256',
  },
  json: { short: undefined, description: 'Output result in JSON format' },

  'debug-port': {
    short: undefined,
    description: 'Chrome DevTools port (off by default)',
    string: true,
    arg: 'PORT',
  },
  'source-window-id': {
    short: undefined,
    description: 'Source terminal window ID that launched this viewer session',
    string: true,
    arg: 'ID',
  },
} as const;

export type Option = keyof typeof possibleOptions;
type ShortOption = Exclude<(typeof possibleOptions)[Option]['short'], undefined>;

const shortOptions = Object.fromEntries(
  Object.entries(possibleOptions)
    .filter(([, value]) => value.short !== undefined)
    .map(([key, value]) => [value.short, key]),
) as {
  [K in ShortOption]: Option;
};

function isDirectory(value: string): boolean {
  try {
    return statSync(value).isDirectory();
  } catch {
    return false;
  }
}

/** A bare argument that names an existing file or directory is a path, not a hostname. */
function isLocalPath(value: string, cwd: string): boolean {
  // An empty value would resolve to cwd itself.
  if (!value.trim()) return false;
  try {
    const stats = statSync(path.resolve(cwd, value));
    return stats.isFile() || stats.isDirectory();
  } catch {
    return false;
  }
}

const supportedSchemes = ['http://', 'https://', 'file://', 'data:', 'awrit://'];

export type ParsedOptions = {
  [K in Option]?: (typeof possibleOptions)[K] extends { string: true } ? string : boolean;
} & { nonFlagArgs?: string[]; deviceCommand?: string };

/** Reject unsupported launch syntax before it can be mistaken for a URL. */
export function launchArgumentError(argv: string[]): string | undefined {
  if (argv[0] === 'android') return 'Unknown command: android';
  for (const arg of argv) {
    if (!arg.startsWith('-')) continue;
    const long = arg.startsWith('--');
    const key = arg.slice(long ? 2 : 1).split('=', 1)[0];
    if (!Object.hasOwn(long ? possibleOptions : shortOptions, key))
      return `Unknown option: ${arg.split('=', 1)[0]}`;
  }
  const parsed = parseArgs(argv);
  if (parsed.deviceCommand !== undefined) return undefined;
  const urlOption = argv.some((arg) => arg === '--url' || arg.startsWith('--url='));
  const extra = parsed.nonFlagArgs?.[urlOption ? 0 : 1];
  if (extra !== undefined) return `Unexpected argument: ${extra}. Use: awrit [options] [url]`;
  // Electron does not render folder listings, so a folder would only show a "File not found" page.
  if (parsed.url?.startsWith('file:') && isDirectory(fileURLToPath(parsed.url)))
    return `${parsed.url} is a folder. Open a file inside it, for example: awrit ${path.join(fileURLToPath(parsed.url), 'index.html')}`;
  return undefined;
}

export function parseArgs(argv: string[], cwd = process.cwd()): ParsedOptions {
  const result: ParsedOptions = {};
  const nonFlags: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('-')) {
      const isDoubleDash = arg.startsWith('--');
      const optionArg = arg.slice(isDoubleDash ? 2 : 1);
      const equals = optionArg.indexOf('=');
      const rawKey = equals === -1 ? optionArg : optionArg.slice(0, equals);
      const inlineVal = equals === -1 ? undefined : optionArg.slice(equals + 1);

      if (!Object.hasOwn(isDoubleDash ? possibleOptions : shortOptions, rawKey)) {
        continue;
      }

      const key = isDoubleDash ? (rawKey as Option) : shortOptions[rawKey as ShortOption];
      const isStringOpt = 'string' in possibleOptions[key];

      if (isStringOpt) {
        if (inlineVal !== undefined) {
          result[key] = inlineVal as any;
        } else if (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
          result[key] = argv[++i] as any;
        } else {
          result[key] = '' as any;
        }
      } else {
        result[key] = true as any;
      }
    } else {
      if (arg === 'help' && argv.length === 1) {
        result.help = true;
        continue;
      }
      if (
        arg === 'device' &&
        nonFlags.length === 0 &&
        !result.url &&
        result.deviceCommand === undefined
      ) {
        result.deviceCommand = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : '';
        continue;
      }
      nonFlags.push(arg);
      if (!result.url) {
        result.url = arg;
      }
    }
  }

  result.nonFlagArgs = nonFlags;

  if (
    typeof result.url === 'string' &&
    !supportedSchemes.some((scheme) => (result.url as string).startsWith(scheme))
  ) {
    result.url = isLocalPath(result.url, cwd)
      ? pathToFileURL(path.resolve(cwd, result.url)).href
      : `${LOOPBACK_ADDRESS.test(result.url) ? 'http' : 'https'}://${result.url}`;
  }

  return result;
}

export const options: ParsedOptions = parseArgs(rawArgs);
