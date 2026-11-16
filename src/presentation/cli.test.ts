import { expect, test } from 'bun:test';
import path from 'node:path';

const entry = path.join(import.meta.dir, 'main.ts');
async function run(args: string[], env?: NodeJS.ProcessEnv) {
  const child = Bun.spawn([process.execPath, entry, ...args], {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test('captured capabilities stdout stays JSON and unverified', async () => {
  const result = await run(['capabilities', '--json']);
  expect(result.code).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.schemaVersion).toBe(1);
  expect(report.stdout.isTTY).toBe(false);
  expect(report.modes.inline.supported).toBe(false);
  expect(report.detected.verifiedGraphics).toBe(false);
  expect(result.stdout).not.toContain('\x1b');
});
test('command help and invalid JSON requests do not launch Electron', async () => {
  expect((await run(['inline', '--help'])).stdout).toContain('Usage: awrit inline');
  expect((await run(['video', '--help'])).stdout).toContain('Usage: awrit video PATH');
  const missingVideo = await run(['video', '--json']);
  expect(missingVideo.code).toBe(2);
  expect(JSON.parse(missingVideo.stdout).error).toContain('local recording path');
  const bad = await run(['snapshot', '--json']);
  expect(bad.code).toBe(2);
  expect(JSON.parse(bad.stdout).error).toContain('requires TARGET');
  expect(bad.stderr).toBe('');
});

test.skipIf(!Bun.which('ffmpeg') || !Bun.which('ffprobe'))('video JSON can render prepared frames without another decode', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-video-cli-'));
  try {
    const source = path.join(dir, 'clip.mp4');
    const encode = Bun.spawn(['ffmpeg', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=32x32:d=1', '-y', source], { stdout: 'ignore', stderr: 'pipe' });
    expect(await encode.exited).toBe(0);
    const result = await run(['video', '--json', source], {
      ...process.env,
      HOME: dir,
      XDG_DATA_HOME: dir,
    });
    expect(result.code).toBe(0);
    const receipt = JSON.parse(result.stdout);
    const prepared = JSON.parse(receipt.marker.slice('awrit-video:'.length));
    expect(receipt.marker).toStartWith('awrit-video:');
    expect(prepared.id).toBe(receipt.id);
    expect(prepared.dir).toBe(receipt.dir);
    expect(prepared.count).toBeGreaterThan(0);
    expect(receipt.next_step).toContain('not playing');
    expect(receipt.next_step).toContain('do not call the video tool again');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('plain Node bundle supports capabilities without Electron dependencies', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-presentation-node-'));
  try {
    const output = path.join(dir, 'cli.cjs');
    const build = await Bun.build({
      entrypoints: [entry],
      target: 'node',
      format: 'cjs',
      external: ['awrit-native-rs'],
    });
    expect(build.success).toBe(true);
    await Bun.write(output, build.outputs[0]);
    const node = Bun.spawn(['node', output, 'capabilities', '--json'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [text, code] = await Promise.all([new Response(node.stdout).text(), node.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(text).schemaVersion).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('show returns source-targeted launch receipt under captured stdout', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-cli-launch-'));
  try {
    const binary = path.join(dir, 'kitten');
    writeFileSync(
      binary,
      `#!/usr/bin/env node\nconst args=process.argv.slice(2); if(args.includes('ls')) console.log(JSON.stringify([{tabs:[{layout:'splits',windows:[{id:7}]}]}])); else if(args.includes('launch')) console.log('8'); else process.exit(1);\n`,
    );
    chmodSync(binary, 0o755);
    const child = Bun.spawn([process.execPath, entry, 'show', 'https://example.com', '--json'], {
      env: {
        ...process.env,
        PATH: dir + path.delimiter + process.env.PATH,
        KITTY_WINDOW_ID: '7',
        KITTY_LISTEN_ON: 'unix:/test-socket',
        AWRIT_LAUNCHER: '/fake/awrit',
        AWRIT_IPC_SOCKET: path.join(dir, 'test.sock'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [text, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(text)).toEqual({ id: 8, source: 7, mode: 'split', readiness: 'launched' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('show reclaims and navigates existing viewer session via IPC when socket is alive', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const net = await import('node:net');
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-cli-nav-'));
  const testSock = path.join(dir, 'nav.sock');

  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split(String.fromCharCode(10));
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'viewer:navigate') {
          sock.write(
            JSON.stringify({
              type: 'viewer:navigate:response',
              requestId: msg.requestId,
              ok: true,
              data: { navigated: true, url: msg.target, kittyWindowId: '42' },
            }) + String.fromCharCode(10),
          );
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(testSock, () => resolve(undefined)));

  try {
    const child = Bun.spawn([process.execPath, entry, 'show', 'https://example.com', '--json'], {
      env: {
        ...process.env,
        KITTY_WINDOW_ID: '7',
        KITTY_LISTEN_ON: 'unix:/test-socket',
        AWRIT_LAUNCHER: '/fake/awrit',
        AWRIT_IPC_SOCKET: testSock,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [text, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(text)).toEqual({
      id: 42,
      source: 7,
      mode: 'split',
      readiness: 'navigated',
      url: 'https://example.com/',
    });
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

function createFakeKittenHarness(dir: string, logFile: string) {
  const { writeFileSync, chmodSync } = require('node:fs');
  const binary = path.join(dir, 'kitten');
  writeFileSync(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
if (args.includes('ls')) {
  console.log(JSON.stringify([{ tabs: [{ layout: 'splits', windows: [{ id: 7 }] }] }]));
} else if (args.includes('launch')) {
  console.log('88');
} else {
  process.exit(1);
}
`,
  );
  chmodSync(binary, 0o755);
}

function getKittenLaunches(logFile: string): string[] {
  const { existsSync, readFileSync } = require('node:fs');
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .filter((line: string) => line.includes('"launch"'));
}

test('show navigation delayed 1100ms succeeds with 0 launches', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const net = await import('node:net');
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-cli-nav-delayed-'));
  const testSock = path.join(dir, 'nav.sock');
  const logFile = path.join(dir, 'kitten.log');
  createFakeKittenHarness(dir, logFile);

  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'viewer:navigate') {
          setTimeout(() => {
            if (!sock.destroyed && sock.writable) {
              sock.write(
                JSON.stringify({
                  type: 'viewer:navigate:response',
                  requestId: msg.requestId,
                  ok: true,
                  data: { navigated: true, url: msg.target, kittyWindowId: '42' },
                }) + '\n',
              );
            }
          }, 1100);
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(testSock, () => resolve(undefined)));

  try {
    const child = Bun.spawn([process.execPath, entry, 'show', 'https://example.com', '--json'], {
      env: {
        ...process.env,
        PATH: dir + path.delimiter + process.env.PATH,
        KITTY_WINDOW_ID: '7',
        KITTY_LISTEN_ON: 'unix:/test-socket',
        AWRIT_LAUNCHER: '/fake/awrit',
        AWRIT_IPC_SOCKET: testSock,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [text, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const receipt = JSON.parse(text);
    expect(receipt.readiness).toBe('navigated');
    expect(receipt.id).toBe(42);
    expect(getKittenLaunches(logFile).length).toBe(0);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test('show navigation refusal, server-error, invalid response, or disconnect exits nonzero with 0 launches', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const net = await import('node:net');

  type FailureMode =
    | 'design-mode'
    | 'server-error'
    | 'invalid-response'
    | 'disconnect'
    | 'missing-ok'
    | 'nonboolean-ok'
    | 'timeout';
  const modes: FailureMode[] = [
    'design-mode',
    'server-error',
    'invalid-response',
    'disconnect',
    'missing-ok',
    'nonboolean-ok',
    'timeout',
  ];

  for (const mode of modes) {
    const dir = mkdtempSync(path.join(tmpdir(), `awrit-cli-nav-${mode}-`));
    const testSock = path.join(dir, 'nav.sock');
    const logFile = path.join(dir, 'kitten.log');
    createFakeKittenHarness(dir, logFile);

    const server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d.toString();
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const msg = JSON.parse(line);
          if (msg.type === 'viewer:navigate') {
            if (mode === 'design-mode') {
              sock.write(
                JSON.stringify({
                  type: 'viewer:navigate:response',
                  requestId: msg.requestId,
                  ok: true,
                  data: { navigated: false, reason: 'design-mode-active', url: msg.target },
                }) + '\n',
              );
            } else if (mode === 'server-error') {
              sock.write(
                JSON.stringify({
                  type: 'viewer:navigate:response',
                  requestId: msg.requestId,
                  ok: false,
                  error: 'internal viewer failure',
                }) + '\n',
              );
            } else if (mode === 'invalid-response') {
              sock.write(
                JSON.stringify({
                  type: 'viewer:navigate:response',
                  requestId: msg.requestId,
                  ok: true,
                  data: { unexpected: 'malformed structure' },
                }) + '\n',
              );
            } else if (mode === 'missing-ok') {
              sock.write(
                JSON.stringify({
                  type: 'viewer:navigate:response',
                  requestId: msg.requestId,
                  data: { navigated: false, reason: 'no-matching-viewer' },
                }) + '\n',
              );
            } else if (mode === 'nonboolean-ok') {
              sock.write(
                JSON.stringify({
                  type: 'viewer:navigate:response',
                  requestId: msg.requestId,
                  ok: 'true',
                  data: { navigated: false, reason: 'no-matching-viewer' },
                }) + '\n',
              );
            } else if (mode === 'disconnect') {
              sock.destroy();
            }
          }
        }
      });
    });

    await new Promise((resolve) => server.listen(testSock, () => resolve(undefined)));

    try {
      const child = Bun.spawn([process.execPath, entry, 'show', 'https://example.com', '--json'], {
        env: {
          ...process.env,
          PATH: dir + path.delimiter + process.env.PATH,
          KITTY_WINDOW_ID: '7',
          KITTY_LISTEN_ON: 'unix:/test-socket',
          AWRIT_LAUNCHER: '/fake/awrit',
          AWRIT_IPC_SOCKET: testSock,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const [text, _stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).not.toBe(0);
      expect(getKittenLaunches(logFile).length).toBe(0);
      const parsed = JSON.parse(text);
      expect(parsed.error).toBeString();
      if (mode === 'timeout') expect(parsed.error).toContain('outcome unknown');
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }
}, 25000);

test('show explicit no-matching-viewer response permits fallback to launch', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const net = await import('node:net');
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-cli-nav-nomatch-'));
  const testSock = path.join(dir, 'nav.sock');
  const logFile = path.join(dir, 'kitten.log');
  createFakeKittenHarness(dir, logFile);

  const server = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'viewer:navigate') {
          sock.write(
            JSON.stringify({
              type: 'viewer:navigate:response',
              requestId: msg.requestId,
              ok: true,
              data: { navigated: false, reason: 'no-matching-viewer' },
            }) + '\n',
          );
        }
      }
    });
  });

  await new Promise((resolve) => server.listen(testSock, () => resolve(undefined)));

  try {
    const child = Bun.spawn([process.execPath, entry, 'show', 'https://example.com', '--json'], {
      env: {
        ...process.env,
        PATH: dir + path.delimiter + process.env.PATH,
        KITTY_WINDOW_ID: '7',
        KITTY_LISTEN_ON: 'unix:/test-socket',
        AWRIT_LAUNCHER: '/fake/awrit',
        AWRIT_IPC_SOCKET: testSock,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [text, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const receipt = JSON.parse(text);
    expect(receipt.readiness).toBe('launched');
    expect(receipt.id).toBe(88);
    expect(getKittenLaunches(logFile).length).toBe(1);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('show missing socket falls back to launch as existing behavior', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-cli-nav-missing-'));
  const testSock = path.join(dir, 'nonexistent.sock');
  const logFile = path.join(dir, 'kitten.log');
  createFakeKittenHarness(dir, logFile);

  try {
    const child = Bun.spawn([process.execPath, entry, 'show', 'https://example.com', '--json'], {
      env: {
        ...process.env,
        PATH: dir + path.delimiter + process.env.PATH,
        KITTY_WINDOW_ID: '7',
        KITTY_LISTEN_ON: 'unix:/test-socket',
        AWRIT_LAUNCHER: '/fake/awrit',
        AWRIT_IPC_SOCKET: testSock,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [text, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const receipt = JSON.parse(text);
    expect(receipt.readiness).toBe('launched');
    expect(receipt.id).toBe(88);
    expect(getKittenLaunches(logFile).length).toBe(1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removed --adb refuses before terminal or device access', async () => {
  const result = await run(['inline', '--adb=explicit-phone']);
  expect(result.code).toBe(2);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('Unknown presentation option: --adb');
});

async function context(args: string[], env: Record<string, string>) {
  const child = Bun.spawn([process.execPath, entry, 'context', ...args], {
    env: { ...process.env, KITTY_WINDOW_ID: '', KITTY_LISTEN_ON: '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { text, code };
}
const kitty = { KITTY_WINDOW_ID: '1', KITTY_LISTEN_ON: 'unix:/tmp/awrit-test-sock' };

test('Claude context uses SessionStart envelope and the inline marker guidance', async () => {
  const { text, code } = await context(['--claude'], kitty);
  expect(code).toBe(0);
  const envelope = JSON.parse(text).hookSpecificOutput;
  expect(envelope.hookEventName).toBe('SessionStart');
  expect(envelope.additionalContext).toContain('awrit capture TARGET --json');
  expect(envelope.additionalContext).toContain('marker` on its own line');
  expect(envelope.additionalContext).toContain('awrit tool snapshot');
  expect(envelope.additionalContext).toContain('awrit overlay TARGET --json');
});

test('non-Claude harness context prioritizes split and shares the path', async () => {
  for (const harness of ['codex', 'opencode', 'generic']) {
    const { text } = await context(['--harness', harness], kitty);
    expect(text).toContain('awrit show TARGET --mode split --json');
    expect(text).toContain('awrit capture TARGET --json');
    expect(text).not.toContain('chat renders it inline');
  }
});

test('context is empty outside Kitty', async () => {
  const { text, code } = await context(['--claude'], { KITTY_LISTEN_ON: kitty.KITTY_LISTEN_ON });
  expect(code).toBe(0);
  expect(text).toBe('');
  const json = await context(['--json'], { KITTY_LISTEN_ON: kitty.KITTY_LISTEN_ON });
  expect(json.code).toBe(0);
  expect(JSON.parse(json.text).guidance).toBe('');
});

test('context rejects an unknown harness', async () => {
  expect((await context(['--harness', 'nope'], kitty)).code).toBe(2);
});

test('status rejects extra arguments and unknown options', async () => {
  for (const args of [['bogus'], ['--bogus']]) {
    const result = await run(['status', ...args], { ...process.env, KITTY_WINDOW_ID: '' });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('Usage: awrit status [--json]');
    expect(result.stdout).toBe('');
  }
  const asJson = await run(['status', 'bogus', '--json'], { ...process.env, KITTY_WINDOW_ID: '' });
  expect(asJson.code).toBe(2);
  expect(JSON.parse(asJson.stdout).error).toContain('Usage: awrit status [--json]');
});

test('status --json prints the viewer state as before', async () => {
  const result = await run(['status', '--json'], { ...process.env, KITTY_WINDOW_ID: '' });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ viewer: false, viewers: [] });
});

test('runtime failures exit 1, not 2', async () => {
  const result = await run(['snapshot', 'page.html', '--out', 'shot.png', '--json'], {
    ...process.env,
    AWRIT_CAPTURE_ENTRY: '',
  });
  expect(result.code).toBe(1);
  expect(JSON.parse(result.stdout).error).toContain('Snapshot entry is missing');
});

test('a target that is not a usable file is misuse', async () => {
  const result = await run(['show', './no-such-file.png', '--json'], {
    ...process.env,
    KITTY_WINDOW_ID: '',
  });
  expect(result.code).toBe(2);
  expect(JSON.parse(result.stdout).error).toContain('does not exist');
});

test('forward misuse is usage error; missing consent terminal is a runtime failure', async () => {
  const target = 'http://127.0.0.1:5599/';
  const nonLoopback = await run(['show', 'http://example.com:5599/', '--host', 'somehost', '--forward', '5599']);
  expect(nonLoopback.code).toBe(2);
  expect(nonLoopback.stderr).toContain('--forward requires localhost or 127.0.0.1');
  const mismatch = await run(['show', 'http://127.0.0.1:1234/', '--host', 'somehost', '--forward', '5599']);
  expect(mismatch.code).toBe(2);
  expect(mismatch.stderr).toContain('does not match the URL port');
  const nonTty = await run(['show', target, '--host', 'somehost', '--forward', '5599']);
  expect(nonTty.code).toBe(1);
  expect(nonTty.stderr).toContain('interactive terminal');
});

test('source presentation resolves local targets in the caller directory', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-source-cwd-'));
  try {
    writeFileSync(path.join(dir, 'page.html'), '<p>hello</p>');
    const binary = path.join(dir, 'kitten');
    writeFileSync(
      binary,
      `#!/usr/bin/env node\nconst args=process.argv.slice(2);if(args.includes('ls'))console.log(JSON.stringify([{tabs:[{layout:'splits',windows:[{id:7}]}]}]));else console.log('8');\n`,
    );
    chmodSync(binary, 0o755);
    const child = Bun.spawn(
      [
        process.execPath,
        path.join(import.meta.dir, '../runner/index.ts'),
        'show',
        'page.html',
        '--json',
      ],
      {
        env: {
          ...process.env,
          AWRIT_CALLER_CWD: dir,
          PATH: dir + path.delimiter + process.env.PATH,
          KITTY_WINDOW_ID: '7',
          KITTY_LISTEN_ON: 'unix:/fake',
          AWRIT_IPC_SOCKET: path.join(dir, 'test.sock'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(JSON.parse(text).id).toBe(8);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('source shell preserves caller cwd through Nix re-execution', async () => {
  const { mkdtempSync, realpathSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'awrit-reexec-')));
  try {
    const fakeNix = path.join(dir, 'nix-shell');
    writeFileSync(fakeNix, '#!/bin/bash\nexport IN_NIX_SHELL=1\nexec bash -c "$3"\n');
    chmodSync(fakeNix, 0o755);
    const fakeBun = path.join(dir, 'bun');
    writeFileSync(fakeBun, '#!/bin/bash\nprintf "%s\\n" "$AWRIT_CALLER_CWD"\n');
    chmodSync(fakeBun, 0o755);
    const env = { ...process.env, PATH: dir + path.delimiter + process.env.PATH };
    delete env.IN_NIX_SHELL;
    delete env.AWRIT_CALLER_CWD;
    const child = Bun.spawn(['bash', path.join(import.meta.dir, '../../awrit'), 'capabilities'], {
      cwd: dir,
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect(code).toBe(0);
    expect(text.trim()).toBe(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('overlay command fails gracefully without KITTY_WINDOW_ID and supports status query', async () => {
  const envNoKitty = { ...process.env };
  delete envNoKitty.KITTY_WINDOW_ID;
  const childBad = Bun.spawn([process.execPath, entry, 'overlay', 'status', '--json'], {
    env: envNoKitty,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [badText, badCode] = await Promise.all([
    new Response(childBad.stdout).text(),
    childBad.exited,
  ]);
  // No Kitty window is an environment failure, not argument misuse.
  expect(badCode).toBe(1);
  expect(JSON.parse(badText).error).toContain('KITTY_WINDOW_ID');

  const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-cli-overlay-'));
  try {
    const binary = path.join(dir, 'kitten');
    writeFileSync(
      binary,
      `#!/usr/bin/env node\nconst args=process.argv.slice(2); if(args.includes('ls')) console.log(JSON.stringify([{tabs:[{windows:[{id:7}]}]}])); else process.exit(1);\n`,
    );
    chmodSync(binary, 0o755);
    const child = Bun.spawn([process.execPath, entry, 'overlay', 'status', '--json'], {
      env: {
        ...process.env,
        PATH: dir + path.delimiter + process.env.PATH,
        KITTY_WINDOW_ID: '7',
        KITTY_LISTEN_ON: 'unix:/test-socket',
        AWRIT_LAUNCHER: '/fake/awrit',
        AWRIT_IPC_SOCKET: path.join(dir, 'test.sock'),
        XDG_DATA_HOME: dir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [text, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    expect(JSON.parse(text)).toMatchObject({ action: 'status', open: false, source: 7 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('capture command validates region format', async () => {
  const bad = await run(['capture', '--region=invalid', '--json']);
  expect(bad.code).toBe(2);
  expect(JSON.parse(bad.stdout).error).toContain('--region must be formatted as X,Y,WIDTH,HEIGHT');
});

test('show --mode overlay routes through toggleOverlay and records session state', async () => {
  const { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-cli-overlay-'));
  try {
    const binary = path.join(dir, 'kitten');
    writeFileSync(
      binary,
      `#!/usr/bin/env node\nconst args=process.argv.slice(2); if(args.includes('ls')) console.log(JSON.stringify([{tabs:[{windows:[{id:7,columns:120},{id:8,foreground_processes:[{cmdline:['/x/awrit','show']}]}]}]}])); else if(args.includes('launch')) console.log('8'); else process.exit(0);\n`,
    );
    chmodSync(binary, 0o755);
    const run = async () => {
      const child = Bun.spawn(
        [process.execPath, entry, 'show', 'https://example.com', '--mode', 'overlay', '--json'],
        {
          env: {
            ...process.env,
            PATH: dir + path.delimiter + process.env.PATH,
            KITTY_WINDOW_ID: '7',
            KITTY_LISTEN_ON: 'unix:/test-socket',
            AWRIT_LAUNCHER: '/fake/awrit',
        AWRIT_IPC_SOCKET: path.join(dir, 'test.sock'),
            XDG_DATA_HOME: dir,
          },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const text = await new Response(child.stdout).text();
      await child.exited;
      return JSON.parse(text);
    };
    expect(await run()).toMatchObject({ action: 'opened', id: 8, viewerRunning: true });
    expect(await run()).toMatchObject({ action: 'already-open', id: 8 });
    expect(existsSync(dir)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unified setup prints a readable dry run and preserves JSON output', async () => {
  const { mkdtempSync, mkdirSync, rmSync, readdirSync, realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  // Kitty setup refuses symlinked parents, and macOS temp dirs sit under the /var symlink.
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'awrit-setup-summary-')));
  try {
    mkdirSync(path.join(dir, '.codex'));
    mkdirSync(path.join(dir, '.config', 'opencode'), { recursive: true });
    const env = {
      HOME: dir,
      PATH: dir,
      CODEX_HOME: path.join(dir, '.codex'),
      XDG_CONFIG_HOME: path.join(dir, '.config'),
      AWRIT_LAUNCHER: process.execPath,
      AWRIT_KITTEN_PATH: path.join(import.meta.dir, '../../kittens/awrit.py'),
      AWRIT_IPC_SOCKET: path.join(dir, 'test.sock'),
      AWRIT_SKILL_PATH: path.join(import.meta.dir, '../../skills/awrit/SKILL.md'),
    };
    for (const json of [false, true]) {
      const child = Bun.spawn(
        [process.execPath, entry, 'setup', '--dry-run', '--yes', ...(json ? ['--json'] : [])],
        {
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      );
      const [text, stderr, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      if (json) {
        expect(JSON.parse(text)).toMatchObject({ dryRun: true, selected: ['codex', 'opencode'] });
      } else {
        expect(text).toContain('Dry run. No changes made.');
        expect(text).toContain('Codex: instructions would install');
        expect(text).toContain('<!-- awrit:begin');
        expect(text.startsWith('{')).toBe(false);
      }
    }
    expect(readdirSync(path.join(dir, '.codex'))).toEqual([]);
    expect(readdirSync(path.join(dir, '.config', 'opencode'))).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
