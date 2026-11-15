import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from '../args';
import { runAndroidCli } from './androidCli';
import * as manager from './androidManager';

describe('runAndroidCli', () => {
  let dir = '';
  const prev = process.env.AWRIT_ANDROID_REGISTRY_PATH;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'awrit-cli-'));
    process.env.AWRIT_ANDROID_REGISTRY_PATH = path.join(dir, 'devices.json');
  });
  afterAll(() => {
    if (prev) process.env.AWRIT_ANDROID_REGISTRY_PATH = prev;
    else delete process.env.AWRIT_ANDROID_REGISTRY_PATH;
    rmSync(dir, { recursive: true, force: true });
  });

  test('runs lifecycle commands and returns exit codes', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(
        await runAndroidCli(parseArgs(['device', 'create', 'cli-a', '--port=65490', '--json'])),
      ).toBe(0);
      expect(await runAndroidCli(parseArgs(['device', 'create', 'cli-a', '--json']))).toBe(1);
      expect(await runAndroidCli(parseArgs(['device', 'delete', 'cli-a', '--json', '--force']))).toBe(0);
    } finally {
      log.mockRestore();
    }
  });

  test('lifecycle commands without a device name are usage errors', async () => {
    const action = spyOn(manager, 'executeDeviceAction');
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const cmd of ['create', 'start', 'stop', 'delete']) {
        expect(await runAndroidCli(parseArgs(['device', cmd]))).toBe(2);
      }
      expect(error.mock.calls[0]?.[0]).toBe('Name the device. Use: awrit device create NAME');
      expect(action).not.toHaveBeenCalled();
    } finally {
      action.mockRestore();
      error.mockRestore();
    }
  });

  test('targeted install and reverse retain their positional values and both ports', async () => {
    const action = spyOn(manager, 'executeDeviceAction').mockResolvedValue({
      ok: true,
      message: 'ok',
    });
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      await runAndroidCli(parseArgs(['device', 'install', 'phone', 'app.apk']));
      expect(action.mock.calls[0]?.slice(0, 2)).toEqual(['install', 'phone']);
      expect(action.mock.calls[0]?.[2]?.apk).toBe('app.apk');
      await runAndroidCli(parseArgs(['device', 'reverse', 'phone', '8080:9090']));
      expect(action.mock.calls[1]?.[2]?.ports).toBe('8080:9090');
      await runAndroidCli(parseArgs(['device', 'reverse', 'phone', '--port=8080:9090']));
      expect(action.mock.calls[2]?.[2]?.ports).toBe('8080:9090');
    } finally {
      action.mockRestore();
      log.mockRestore();
    }
  });

  test('JSON start never writes terminal progress, even on a TTY', async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stderr, 'isTTY');
    Object.defineProperty(process.stderr, 'isTTY', { configurable: true, value: true });
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true);
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runAndroidCli(parseArgs(['device', 'start', 'missing', '--json']))).toBe(1);
      expect(write).not.toHaveBeenCalled();
    } finally {
      write.mockRestore();
      log.mockRestore();
      if (descriptor) Object.defineProperty(process.stderr, 'isTTY', descriptor);
      else Reflect.deleteProperty(process.stderr, 'isTTY');
    }
  });

  test('--resolution is validated and forwarded unchanged', async () => {
    const action = spyOn(manager, 'executeDeviceAction').mockResolvedValue({
      ok: true,
      message: 'ok',
    });
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(
        await runAndroidCli(parseArgs(['device', 'create', 'phone', '--resolution=1080x1920@420'])),
      ).toBe(0);
      expect(action.mock.calls[0]?.[2]?.resolution).toEqual({
        width: 1080,
        height: 1920,
        density: 420,
      });
      for (const raw of ['1080', '0x0', '1080x1920@0', '1080x1920@700', '200x200', '1080X1920']) {
        action.mockClear();
        expect(
          await runAndroidCli(parseArgs([`device`, `create`, 'phone', `--resolution=${raw}`])),
        ).toBe(2);
        expect(action).not.toHaveBeenCalled();
        expect(String(error.mock.calls.at(-1)?.[0])).toContain('widthxheight[@dpi]');
      }
    } finally {
      error.mockRestore();
      action.mockRestore();
      log.mockRestore();
    }
  });

  test('view only falls through to Electron when it has a name and no --json', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runAndroidCli(parseArgs(['device', 'view', 'phone']))).toBeNull();
      expect(await runAndroidCli(parseArgs(['device', 'view', 'phone', '--json']))).toBe(0);
      expect(await runAndroidCli(parseArgs(['device', 'view']))).toBe(1);
    } finally {
      log.mockRestore();
    }
  });

  test('remote view dispatches to SSH client without any local device action', async () => {
    const client = await import('../remote/client');
    const runtime = await import('../remote/resolveRuntime');
    const show = spyOn(client, 'runRemoteShow').mockResolvedValue(0);
    const resolve = spyOn(runtime, 'resolveRemoteRuntime').mockResolvedValue('/remote/awrit');
    const action = spyOn(manager, 'executeDeviceAction');
    try {
      const parsed = parseArgs([
        'device',
        'view',
        'phone',
        '--host',
        'phoenix',
        '--remote-awrit',
        '/remote/awrit',
        '--session',
        'saved',
      ]);
      expect(await runAndroidCli(parsed)).toBe(0);
      expect(resolve).toHaveBeenCalledWith('phoenix', '/remote/awrit');
      expect(show).toHaveBeenCalledWith({
        alias: 'phoenix',
        url: 'android://phone',
        android: 'phone',
        runtimePath: '/remote/awrit',
        session: 'saved',
      });
      expect(action).not.toHaveBeenCalled();
    } finally {
      show.mockRestore();
      resolve.mockRestore();
      action.mockRestore();
    }
  });

  test('rejects --host for local device-management commands', async () => {
    const action = spyOn(manager, 'executeDeviceAction');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const parsed = parseArgs(['device', 'start', 'phone', '--host', 'phoenix']);
      expect(parsed.host).toBe('phoenix');
      expect(await runAndroidCli(parsed)).toBe(2);
      expect(action).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(
        '--host is supported only by device view; no local device action was started.',
      );
    } finally {
      action.mockRestore();
      log.mockRestore();
    }
  });

  test('rejects unknown subcommands instead of silently listing', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    const action = spyOn(manager, 'executeDeviceAction').mockResolvedValue({ ok: true, message: 'ok' });
    try {
      expect(await runAndroidCli(parseArgs(['device', 'bogus']))).toBe(2);
      expect(String(error.mock.calls.at(-1)?.[0])).toContain('Unknown device command');
      for (const argv of [
        ['device', 'list', 'extra'],
        ['device', 'prune', 'extra'],
        ['device', 'delete', 'a', 'b'],
        ['device', 'install', 'phone', 'app.apk', 'extra'],
        ['device', 'create', 'phone', '--port=abc'],
        ['device', 'create', 'phone', '--port=70000'],
      ]) {
        expect(await runAndroidCli(parseArgs(argv))).toBe(2);
      }
      expect(action).not.toHaveBeenCalled();
      expect(String(error.mock.calls.at(-1)?.[0])).toContain('--port');
      expect(await runAndroidCli(parseArgs(['device', 'create', 'phone', '--port=5560']))).toBe(0);
      expect(action.mock.calls[0]?.[2]?.port).toBe(5560);
      expect(await runAndroidCli(parseArgs(['device', 'list', '--json']))).toBe(0);
    } finally {
      action.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });

  test('rejects options that the verb does not use', async () => {
    const action = spyOn(manager, 'executeDeviceAction').mockResolvedValue({
      ok: true,
      message: 'ok',
    });
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    try {
      for (const argv of [
        ['device', 'list', '--api=zz'],
        ['device', 'start', 'phone', '--out=x'],
        ['device', 'show', 'phone', '--yes'],
        ['device', 'prune', '--force'],
        ['device', 'screenshot', 'phone', '--api=33'],
        ['device', 'reverse', 'phone', '--out=x'],
      ]) {
        expect(await runAndroidCli(parseArgs(argv))).toBe(2);
        const message = String(error.mock.calls.at(-1)?.[0]);
        expect(message).toContain('--help');
      }
      expect(action).not.toHaveBeenCalled();
      expect(await runAndroidCli(parseArgs(['device', 'delete', 'phone', '--yes']))).toBe(0);
      expect(await runAndroidCli(parseArgs(['device', 'prune', '--yes', '--json']))).toBe(0);
      expect(
        await runAndroidCli(parseArgs(['device', 'view', 'phone', '--bitrate=4M'])),
      ).toBeNull();
      // The kitten opens device views with --overlay; the viewer owns view flags.
      expect(await runAndroidCli(parseArgs(['device', 'view', 'phone', '--overlay']))).toBeNull();
    } finally {
      action.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });

  test('show reports JSON errors when --json is set', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      expect(await runAndroidCli(parseArgs(['device', 'show', '--json']))).toBe(1);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
        error: 'Usage: awrit device show NAME',
      });
      expect(await runAndroidCli(parseArgs(['device', 'show', 'nope', '--json']))).toBe(1);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
        error: "No device named 'nope'. Run: awrit device list",
      });
    } finally {
      log.mockRestore();
    }
  });

  test('--json wraps plain-text failures and leaves JSON messages alone', async () => {
    const action = spyOn(manager, 'executeDeviceAction');
    const log = spyOn(console, 'log').mockImplementation(() => {});
    try {
      action.mockResolvedValue({ ok: false, message: 'Podman binary not found on PATH.' });
      const argv = ['device', 'prune', '--json'];
      expect(await runAndroidCli(parseArgs(argv))).toBe(1);
      expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toEqual({
        error: 'Podman binary not found on PATH.',
      });

      action.mockResolvedValue({ ok: false, message: JSON.stringify({ error: 'already json' }) });
      expect(await runAndroidCli(parseArgs(argv))).toBe(1);
      expect(log.mock.calls.at(-1)?.[0]).toBe(JSON.stringify({ error: 'already json' }));

      action.mockResolvedValue({ ok: false, message: 'Podman binary not found on PATH.' });
      expect(await runAndroidCli(parseArgs(['device', 'prune']))).toBe(1);
      expect(log.mock.calls.at(-1)?.[0]).toBe('Podman binary not found on PATH.');
    } finally {
      action.mockRestore();
      log.mockRestore();
    }
  });

  test('build refuses without license, checksum or https URL, before touching podman', async () => {
    const log = spyOn(console, 'log').mockImplementation(() => {});
    const sha = 'a'.repeat(64);
    try {
      const cases = [
        ['device', 'build'],
        [
          'device',
          'build',
          '--accept-license',
          '--tools-url=http://x/y.zip',
          `--tools-sha256=${sha}`,
        ],
        [
          'device',
          'build',
          '--accept-license',
          '--tools-url=https://x/y.zip',
          '--tools-sha256=nothex',
        ],
      ];
      for (const argv of cases) expect(await runAndroidCli(parseArgs(argv))).toBe(1);
    } finally {
      log.mockRestore();
    }
  });
});
