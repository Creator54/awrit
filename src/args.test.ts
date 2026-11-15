import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { launchArgumentError, parseArgs } from './args';

const DEVICE_VERBS = [
  'doctor',
  'list',
  'prune',
  'create',
  'start',
  'stop',
  'delete',
  'view',
  'screenshot',
  'install',
  'reverse',
  'logcat',
  'build',
];

describe('parseArgs', () => {
  test('recognizes only own options in the matching long or short namespace', () => {
    for (const flag of ['-url', '--h', '--constructor', '--toString', '--__proto__']) {
      expect(launchArgumentError([flag])).toBeDefined();
      expect(parseArgs([flag])).toEqual({ nonFlagArgs: [] });
    }
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['--help']).help).toBe(true);
  });

  test('recognizes device view after Electron-injected flags', () => {
    const opts = parseArgs([
      '--high-dpi-support=1',
      '--force-device-scale-factor=1.25',
      'device',
      'view',
      'phone',
    ]);
    expect(opts.deviceCommand).toBe('view');
    expect(opts.nonFlagArgs).toEqual(['phone']);
  });

  test('parses every device verb', () => {
    for (const verb of DEVICE_VERBS) {
      const opts = parseArgs(['device', verb]);
      expect(opts.deviceCommand).toBe(verb);
    }
  });

  test('device with no verb lists devices', () => {
    expect(parseArgs(['device']).deviceCommand).toBe('');
    expect(parseArgs(['--pick']).pick).toBe(true);
  });

  test('captures nonFlagArgs and device names correctly', () => {
    const opts = parseArgs(['device', 'create', 'my-phone', '--api=13', '--port=5560']);
    expect(opts.deviceCommand).toBe('create');
    expect(opts.nonFlagArgs).toEqual(['my-phone']);
    expect(opts.api).toBe('13');
    expect(opts.port).toBe('5560');
  });

  test('an existing file path becomes a file:// URL, not a hostname', () => {
    const opts = parseArgs([import.meta.path]);
    expect(opts.url).toBe(`file://${import.meta.path}`);
    expect(parseArgs(['args.test.ts'], import.meta.dir).url).toBe(`file://${import.meta.path}`);
  });

  test('an existing directory becomes a file:// URL, not a hostname', () => {
    const dir = path.resolve(import.meta.dir, 'presentation');
    expect(parseArgs(['presentation'], import.meta.dir).url).toBe(pathToFileURL(dir).href);
    expect(parseArgs(['presentation/'], import.meta.dir).url).toBe(pathToFileURL(dir).href);
    // The launcher rejects it: Electron cannot show a folder listing.
    expect(launchArgumentError([dir])).toContain('is a folder. Open a file inside it');
    expect(launchArgumentError([`file://${dir}/`])).toContain('is a folder');
    expect(launchArgumentError([import.meta.path])).toBeUndefined();
    // An empty value must not resolve to the working directory.
    expect(parseArgs(['--url', ''], import.meta.dir).url).toBe('https://');
  });

  test('defaults url scheme to https://', () => {
    const opts = parseArgs(['example.com']);
    expect(opts.url).toBe('https://example.com');
  });

  test('preserves supported schemes for url', () => {
    const opts = parseArgs(['awrit://adb']);
    expect(opts.url).toBe('awrit://adb');
  });

  test('opens loopback addresses over HTTP', () => {
    for (const address of ['localhost', 'localhost:3000/app', '127.0.0.1:8080', '[::1]:8080']) {
      expect(parseArgs([address]).url).toBe(`http://${address}`);
    }
    expect(parseArgs(['example.com:8080']).url).toBe('https://example.com:8080');
    expect(parseArgs(['localhost.example.com']).url).toBe('https://localhost.example.com');
  });

  test('parses --debug-port', () => {
    const opts = parseArgs(['--debug-port=9333']);
    expect(opts['debug-port']).toBe('9333');
  });

  test('parses stream resolution and bitrate flags', () => {
    const opts = parseArgs(['--max-size=1280', '--bitrate=8M']);
    expect(opts['max-size']).toBe('1280');
    expect(opts.bitrate).toBe('8M');
  });

  test('parses device resolution flag', () => {
    const opts = parseArgs(['device', 'create', 'dev1', '--resolution=1080x1920@420']);
    expect(opts.resolution).toBe('1080x1920@420');
  });

  test('parses --out for screenshot path', () => {
    const opts = parseArgs(['device', 'screenshot', '--out=/tmp/screen.png']);
    expect(opts.deviceCommand).toBe('screenshot');
    expect(opts.out).toBe('/tmp/screen.png');
  });

  test('only -h and -v remain as short flags', () => {
    expect(parseArgs(['-h']).help).toBe(true);
    expect(parseArgs(['-v']).version).toBe(true);
    expect(parseArgs(['-A', 'list']).android).toBeUndefined();
    expect(parseArgs(['-C', '9444'])['debug-port']).toBeUndefined();
    expect(parseArgs(['-o', 'shot.png']).out).toBeUndefined();
  });
});

describe('launchArgumentError', () => {
  test('rejects unsupported options without migration aliases', () => {
    expect(launchArgumentError(['--unknown=value'])).toBe('Unknown option: --unknown');
    expect(launchArgumentError(['-s'])).toBe('Unknown option: -s');
    expect(launchArgumentError(['android', 'list'])).toBe('Unknown command: android');
    expect(launchArgumentError(['web', 'open'])).toBe(
      'Unexpected argument: open. Use: awrit [options] [url]',
    );
    expect(launchArgumentError(['--url', 'example.com', 'extra'])).toBe(
      'Unexpected argument: extra. Use: awrit [options] [url]',
    );
    expect(launchArgumentError(['device', 'view', 'phone'])).toBeUndefined();
    expect(launchArgumentError(['--url', 'example.com'])).toBeUndefined();
    expect(launchArgumentError(['--url=https://example.com', '-h', '-v'])).toBeUndefined();
  });
});

test('preserves equals signs inside internal presentation JSON', () => {
  const config = JSON.stringify({ text: 'a=b=c', layout: 'text-left' });
  expect(parseArgs([`--presentation-json=${config}`])['presentation-json']).toBe(config);
});

test('a lone `help` shows help instead of opening a page', () => {
  const opts = parseArgs(['help']);
  expect(opts.help).toBe(true);
  expect(opts.url).toBeUndefined();
  expect(parseArgs(['help', 'x']).help).toBeUndefined();
});
