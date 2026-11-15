import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { parsePresentationArgs } from './args';

test('recording preparation requires a local target and does not accept capture/device options', () => {
  expect(parsePresentationArgs(['video', 'qa/after.webm', '--json'])).toMatchObject({
    command: 'video',
    target: 'qa/after.webm',
    json: true,
  });
  expect(parsePresentationArgs(['video', '--json', '--', '-clip.mp4'])?.target).toBe('-clip.mp4');
  expect(() => parsePresentationArgs(['video', '--json'])).toThrow();
  expect(() => parsePresentationArgs(['video', 'clip.mp4', '--adb=phone'])).toThrow();
  expect(() => parsePresentationArgs(['video', 'clip.mp4', '--comment=notes'])).toThrow();
});

test('video overlay accepts explanatory text and rejects unsupported modes', () => {
  expect(
    parsePresentationArgs(['video', 'clip.mp4', '--mode', 'overlay', '--text', 'Review this']),
  ).toMatchObject({ mode: 'overlay', text: 'Review this' });
  expect(() => parsePresentationArgs(['video', 'clip.mp4', '--mode', 'split'])).toThrow(
    'only --mode overlay',
  );
  expect(() => parsePresentationArgs(['video', 'clip.mp4', '--text', 'Review this'])).toThrow(
    'requires --mode overlay',
  );
});

test('presentation parsing leaves browser and device commands alone', () => {
  for (const argv of [[], ['example.com'], ['device', 'view', 'phone'], ['--adb=phone']]) {
    expect(parsePresentationArgs(argv)).toBeNull();
  }
});
test('preserves target values and inline equals signs', () => {
  expect(
    parsePresentationArgs(['show', 'https://example.com/?a=b=c', '--mode=split', '--json']),
  ).toMatchObject({ target: 'https://example.com/?a=b=c', mode: 'split', json: true });
  expect(parsePresentationArgs(['inline', '--', '-image ü.png'])?.target).toBe('-image ü.png');
  expect(parsePresentationArgs(['inline', '--', '--mode=split'])?.target).toBe('--mode=split');
  expect(() => parsePresentationArgs(['inline', '--adb=phone'])).toThrow(
    'Unknown presentation option: --adb',
  );
});
test('rejects ambiguous output and invalid input without fallback', () => {
  for (const argv of [
    ['inline', 'x', '--json'],
    ['capabilities', ''],
    ['inline', '', '--adb=phone'],
    ['inline', 'x', '--adb=phone'],
    ['show', 'x', 'y'],
    ['inline'],
    ['show', 'x', '--mode=bogus'],
    ['show', 'x', '--unknown'],
    ['inline', 'x', '--width=12junk'],
    ['inline', 'x', '--width=0'],
    ['show', 'x', '--mode'],
    ['capabilities', '--mode=split'],
    ['snapshot', 'x'],
    ['snapshot', 'x', '--out=x', '--viewport=4096x4096'],
    ['setup', 'bogus'],
    ['capabilities', '--json=false'],
  ])
    expect(() => parsePresentationArgs(argv)).toThrow();
});
test('bounded snapshots, help and setup dry runs parse', () => {
  expect(
    parsePresentationArgs(['snapshot', 'a.html', '--out', 'shot.png', '--viewport=800x600']),
  ).toMatchObject({ out: 'shot.png', viewport: { width: 800, height: 600 } });
  expect(parsePresentationArgs(['inline', '--help'])?.help).toBe(true);
  expect(parsePresentationArgs(['setup', 'agents', '--claude', '--dry-run'])).toMatchObject({
    claude: true,
    dryRun: true,
  });
});

test('context and explicit reversible setup options parse independently', () => {
  expect(parsePresentationArgs(['context', '--claude'])?.claude).toBe(true);
  expect(parsePresentationArgs(['setup', 'kitty', '--uninstall', '--dry-run'])).toMatchObject({
    uninstall: true,
    dryRun: true,
  });
  expect(() => parsePresentationArgs(['inline', 'image.png', '--uninstall'])).toThrow();
});

test('parses same-pane text, column ratios, layout, and companion mode', () => {
  const parsed = parsePresentationArgs([
    'inline',
    'image.png',
    '--text=Hello world\nSecond line',
    '--columns=45:55',
    '--layout=text-left',
  ]);
  expect(parsed).toMatchObject({
    command: 'inline',
    target: 'image.png',
    text: 'Hello world\nSecond line',
    columns: { text: 45, media: 55 },
    layout: 'text-left',
  });

  const companion = parsePresentationArgs([
    'show',
    'https://example.com',
    '--mode=companion',
    '--text=Preview of site',
    '--layout=media-left',
  ]);
  expect(companion).toMatchObject({
    command: 'show',
    target: 'https://example.com',
    mode: 'companion',
    text: 'Preview of site',
    layout: 'media-left',
  });
});

test('validates --text, --columns, and --layout bounds and rejects invalid inputs', () => {
  // Reject control characters in --text
  expect(() => parsePresentationArgs(['inline', 'image.png', '--text=bad\x00char'])).toThrow(
    '--text contains invalid control characters',
  );

  // Reject --text exceeding 64 KiB
  const hugeText = 'a'.repeat(65537);
  expect(() => parsePresentationArgs(['inline', 'image.png', `--text=${hugeText}`])).toThrow(
    '--text exceeds the 64 KiB limit',
  );

  // Reject malformed --columns
  expect(() => parsePresentationArgs(['inline', 'image.png', '--columns=40'])).toThrow(
    '--columns must be TEXT:MEDIA',
  );
  expect(() => parsePresentationArgs(['inline', 'image.png', '--columns=0:50'])).toThrow(
    '--columns values must be integers between 1 and 1000',
  );
  expect(() => parsePresentationArgs(['inline', 'image.png', '--columns=50:1001'])).toThrow(
    '--columns values must be integers between 1 and 1000',
  );

  // Reject invalid --layout
  expect(() => parsePresentationArgs(['inline', 'image.png', '--layout=top-down'])).toThrow(
    "--layout must be 'text-left' or 'media-left'",
  );

  // Reject --text on unsupported commands
  expect(() =>
    parsePresentationArgs(['snapshot', 'page.html', '--out=p.png', '--text=note']),
  ).toThrow('--text is not supported by snapshot');
  expect(() => parsePresentationArgs(['capabilities', '--text=note'])).toThrow(
    '--text is not supported by capabilities',
  );
});

test('rejects unused or contradictory same-pane options', () => {
  for (const argv of [
    ['show', 'x', '--mode=companion'],
    ['inline', 'x', '--columns=20:20'],
    ['show', 'x', '--layout=text-left'],
    ['inline', 'x', '--text=notes', '--width=40'],
    ['show', 'x', '--text=notes', '--height=4'],
    ['inline', 'x', '--text=bad\u009b2J'],
    ['inline', 'x', '--text=bad\rtext'],
  ])
    expect(() => parsePresentationArgs(argv)).toThrow();
});

test('overlay command parses targets, close, status, and validates conflicts', () => {
  expect(parsePresentationArgs(['overlay', 'https://example.com'])).toMatchObject({
    command: 'overlay',
    mode: 'overlay',
    target: 'https://example.com',
  });
  expect(parsePresentationArgs(['overlay', 'https://example.com', '--json'])).toMatchObject({
    command: 'overlay',
    mode: 'overlay',
    target: 'https://example.com',
    json: true,
  });
  expect(parsePresentationArgs(['overlay', 'close'])).toMatchObject({
    command: 'overlay',
    mode: 'overlay',
    close: true,
  });
  expect(parsePresentationArgs(['overlay', 'status', '--json'])).toMatchObject({
    command: 'overlay',
    mode: 'overlay',
    status: true,
    json: true,
  });
  // Only the verb forms exist.
  expect(() => parsePresentationArgs(['overlay', '--close'])).toThrow('Unknown presentation option: --close');

  // Conflicting options
  expect(() => parsePresentationArgs(['overlay', 'close', 'status'])).toThrow(
    'Use either close or status',
  );
  expect(() => parsePresentationArgs(['overlay', 'close', 'https://example.com'])).toThrow(
    'Cannot specify a target with close or status',
  );
  expect(() => parsePresentationArgs(['overlay', 'status', '--adb=phone'])).toThrow(
    'Unknown presentation option: --adb',
  );
});

test('capture command parses targets, comment, region, and flags', () => {
  expect(parsePresentationArgs(['capture', 'https://example.com', '--comment=Note'])).toMatchObject(
    {
      command: 'capture',
      target: 'https://example.com',
      comment: 'Note',
    },
  );
  expect(
    parsePresentationArgs([
      'capture',
      'https://example.com',
      '--region=10,20,30,40',
      '--wait-ms=500',
      '--wait-selector=#main',
      '--json',
    ]),
  ).toMatchObject({
    command: 'capture',
    target: 'https://example.com',
    region: '10,20,30,40',
    waitMs: 500,
    waitSelector: '#main',
    json: true,
  });
});

test('overlay --text updates the open overlay and rejects other targets', () => {
  expect(parsePresentationArgs(['overlay', '--text', 'hello'])?.text).toBe('hello');
  expect(() => parsePresentationArgs(['overlay', 'close', '--text', 'x'])).toThrow(
    'overlay --text',
  );
  expect(() => parsePresentationArgs(['overlay', 'https://example.com', '--text', 'x'])).toThrow(
    'overlay --text',
  );
  expect(() => parsePresentationArgs(['overlay', '--adb', 'emulator-5554', '--text', 'x'])).toThrow(
    'Unknown presentation option: --adb',
  );
});

test('--browsing option parses valid values, rejects invalid values, and restricts commands/targets', () => {
  // Valid on context
  expect(parsePresentationArgs(['context', '--browsing', 'useful'])).toMatchObject({
    command: 'context',
    browsing: 'useful',
  });
  expect(parsePresentationArgs(['context', '--browsing=always'])).toMatchObject({
    command: 'context',
    browsing: 'always',
  });
  expect(parsePresentationArgs(['context', '--browsing', 'asked'])).toMatchObject({
    command: 'context',
    browsing: 'asked',
  });

  // Valid on setup (full setup and setup agents)
  expect(parsePresentationArgs(['setup', '--browsing', 'useful'])).toMatchObject({
    command: 'setup',
    browsing: 'useful',
  });
  expect(
    parsePresentationArgs(['setup', 'agents', '--claude', '--browsing', 'always']),
  ).toMatchObject({
    command: 'setup',
    target: 'agents',
    claude: true,
    browsing: 'always',
  });

  // Rejects invalid value
  expect(() => parsePresentationArgs(['context', '--browsing', 'invalid'])).toThrow(
    '--browsing must be one of useful, always, asked',
  );

  // Rejects on disallowed commands
  expect(() =>
    parsePresentationArgs(['show', 'https://example.com', '--browsing', 'always']),
  ).toThrow();
  expect(() => parsePresentationArgs(['inline', 'image.png', '--browsing', 'useful'])).toThrow();
  expect(() => parsePresentationArgs(['capabilities', '--browsing', 'useful'])).toThrow();

  // Rejects on setup targets other than agents or full setup
  expect(() => parsePresentationArgs(['setup', 'kitty', '--browsing', 'useful'])).toThrow(
    '--browsing applies only to full setup or setup agents',
  );
  expect(() => parsePresentationArgs(['setup', 'plugins', '--browsing', 'useful'])).toThrow(
    '--browsing applies only to full setup or setup agents',
  );
});

test('show --host parses a remote view and leaves local show unchanged', () => {
  expect(
    parsePresentationArgs([
      'show',
      'https://example.com',
      '--host',
      'phoenix',
      '--remote-awrit',
      '/opt/awrit/awrit',
    ]),
  ).toMatchObject({
    command: 'show',
    target: 'https://example.com',
    host: 'phoenix',
    remoteAwrit: '/opt/awrit/awrit',
  });
  expect(parsePresentationArgs(['show', 'https://example.com'])).toEqual({
    command: 'show',
    target: 'https://example.com',
    mode: 'auto',
    json: false,
    help: false,
    overwrite: false,
    dryRun: false,
    claude: false,
    uninstall: false,
    purge: false,
    yes: false,
  });
  // --host alone probes and installs with consent; --remote-awrit only overrides the path.
  expect(parsePresentationArgs(['show', 'https://example.com', '--host', 'phoenix'])).toMatchObject(
    {
      command: 'show',
      target: 'https://example.com',
      host: 'phoenix',
    },
  );
  for (const argv of [
    ['show', 'https://example.com', '--host'],
    ['show', 'https://example.com', '--remote-awrit', '/opt/awrit'],
    ['inline', 'x', '--host', 'phoenix', '--remote-awrit', '/opt/awrit'],
    ['show', 'https://example.com', '--host', 'phoenix', '--json'],
    ['show', 'https://example.com', '--host', 'phoenix', '--mode', 'split'],
    ['show', 'https://example.com', '--host', 'phoenix', '--adb', 'phone'],
  ])
    expect(() => parsePresentationArgs(argv)).toThrow();
  for (const target of ['data:text/html,x', 'file:///tmp/a.html', './page.html'])
    expect(() => parsePresentationArgs(['show', target, '--host', 'phoenix'])).toThrow(
      '--host opens http:// or https:// pages only',
    );
});

test('show --forward takes a port and requires --host', () => {
  expect(
    parsePresentationArgs([
      'show',
      'http://localhost:3000/',
      '--host',
      'phoenix',
      '--forward',
      '3000',
    ]),
  ).toMatchObject({ command: 'show', host: 'phoenix', forward: 3000 });
  for (const value of ['0', '65536', '-1', '1.5', 'abc', '', '3000ms']) {
    expect(() =>
      parsePresentationArgs([
        'show',
        'http://localhost:3000/',
        '--host',
        'phoenix',
        `--forward=${value}`,
      ]),
    ).toThrow();
  }
  expect(() =>
    parsePresentationArgs(['show', 'http://localhost:3000/', '--forward', '3000']),
  ).toThrow('--forward requires --host');
  expect(() => parsePresentationArgs(['inline', 'x', '--forward', '3000'])).toThrow();
});

test('show --host accepts a session id to reattach', () => {
  const url = 'https://example.com/';
  expect(
    parsePresentationArgs(['show', url, '--host', 'phoenix', '--session', 'a_B-9']).session,
  ).toBe('a_B-9');
  expect(() =>
    parsePresentationArgs(['show', url, '--host', 'phoenix', '--session', 'bad id']),
  ).toThrow('--session is not a valid session id');
  expect(() => parsePresentationArgs(['show', url, '--session', 'abc'])).toThrow(
    '--session requires --host',
  );
  expect(() =>
    parsePresentationArgs(['show', url, '--host', 'p', '--forward', '3000', '--session', 'abc']),
  ).toThrow('--session cannot be used with --forward');
});

test('local presentation commands never import the remote module eagerly', () => {
  const entry = path.join(import.meta.dir, 'cli.ts');
  const script = `await import(${JSON.stringify(entry)}); const loaded = Object.keys(require.cache).filter((file) => file.includes('/src/remote/')); process.stdout.write(JSON.stringify(loaded));`;
  const result = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000 });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('[]');
});

test('--purge is only for full setup --uninstall', () => {
  expect(parsePresentationArgs(['setup', '--uninstall', '--purge']).purge).toBe(true);
  expect(() => parsePresentationArgs(['setup', '--purge'])).toThrow(/--purge/);
  expect(() => parsePresentationArgs(['setup', 'kitty', '--uninstall', '--purge'])).toThrow(/--purge/);
});

test('invalid presentation mode lists the valid modes', () => {
  expect(() => parsePresentationArgs(['show', 'x', '--mode', 'bogus'])).toThrow(
    'Invalid --mode. Use: auto, inline, split, tab, overlay, window, companion',
  );
});

test('context takes no target', () => {
  expect(() => parsePresentationArgs(['context', 'foo'])).toThrow('context takes no target');
});

test('rejects an option supplied twice', () => {
  expect(() =>
    parsePresentationArgs(['capture', 'https://example.com', '--comment', 'a', '--comment', 'b']),
  ).toThrow('Specify --comment only once.');
  expect(() =>
    parsePresentationArgs(['capture', '--region', '1,2,3,4', '--region=5,6,7,8']),
  ).toThrow('Specify --region only once.');
  expect(() =>
    parsePresentationArgs(['snapshot', 'a.html', '--out', 'a.png', '--out', 'b.png']),
  ).toThrow('Specify --out only once.');
  expect(() => parsePresentationArgs(['show', 'x', '--json', '--json'])).toThrow(
    'Specify --json only once.',
  );
});
