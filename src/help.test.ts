import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ANDROID_COMMANDS } from './adb/androidCli';
import { PRESENTATION_COMMANDS } from './presentation/args';

test('help stays concise and exits before picking or running a device action', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-help-'));
  for (const binary of ['fzf', 'podman', 'adb']) {
    writeFileSync(path.join(dir, binary), '#!/bin/sh\nprintf "BACKEND_STARTED\\n"\nexit 77\n', {
      mode: 0o755,
    });
  }
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [new URL('./runner/index.ts', import.meta.url).pathname, ...args], {
      encoding: 'utf8',
      timeout: 10000,
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        AWRIT_ANDROID_REGISTRY_PATH: path.join(dir, 'devices.json'),
      },
    });
  const help = (...args: string[]) => {
    const result = run(...args, '--help');
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).not.toContain('BACKEND_STARTED');
    return result.stdout;
  };
  try {
    const basic = help();
    expect(basic.split('\n').length).toBeLessThan(20);
    expect(basic).toContain('awrit device VERB [NAME]');
    expect(basic).not.toContain('--adb');
    const commandList = basic.split('\n').find((line) => line.startsWith('Commands: '));
    expect(commandList).toBeDefined();
    const listedCommands = commandList?.replace('Commands: ', '').split(', ');
    for (const command of ['device', 'tool', 'status', ...PRESENTATION_COMMANDS]) {
      expect(listedCommands).toContain(command);
      expect(help(command)).toContain(`awrit ${command}`);
    }
    // Every command in the footer must be runnable, so a removed command cannot linger.
    const realCommands = new Set<string>(['device', 'tool', 'status', ...PRESENTATION_COMMANDS]);
    for (const command of listedCommands ?? []) expect(realCommands.has(command)).toBe(true);
    expect(basic).toContain('awrit --dev --help');
    expect(basic).not.toContain('--tools-sha256');
    expect(help('--pick')).toBe(basic);
    expect(help('--dev')).toContain('--no-paint');
    const overview = help('device');
    expect(overview).toContain('Commands:');
    expect(overview).toContain('awrit device VERB --help');
    for (const verb of ANDROID_COMMANDS) expect(overview).toContain(verb);
    const create = help('device', 'create', 'phone');
    expect(create).toContain('device create NAME [options]');
    expect(create).toContain('--api=');
    expect(create).toContain('AOSP 13:');
    const view = help('device', 'view', 'phone');
    expect(view).toContain('device view NAME|SERIAL [options]');
    expect(view).toContain('--max-size=');
    for (const option of ['--host=', '--remote-awrit=', '--session=']) {
      expect(view).toContain(option);
    }
    expect(view).not.toContain('--image=');
    expect(help('device', 'prune')).toContain('--yes');
    const remove = help('device', 'delete', 'phone');
    expect(remove).toContain('--force');
    expect(remove).toContain('--yes');
    expect(help('context')).toContain('claude');
    expect(help('inline')).toContain('AWRIT_TERMINAL_OWNER=shell');
    expect(help('device', 'build')).toContain('--tools-sha256=');
    expect(help('device', 'doctor')).toContain('doctor [options]');
    expect(help('device', 'list')).toContain('list [options]');
    expect(help('device', 'install')).toContain('NAME APK');
    expect(help('device', 'reverse')).toContain('NAME PORT[:PORT]');
    expect(help('device', 'unknown')).toContain('Commands:');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unsupported forms exit with one plain error', () => {
  const cases: [string[], string][] = [
    [['android', 'list'], 'Unknown command: android'],
    [['--android', 'list'], 'Unknown option: --android'],
    [['--android=view', 'phone'], 'Unknown option: --android'],
    [['--adb', 'emulator-5554'], 'Unknown option: --adb'],
  ];
  for (const [args, expected] of cases) {
    const result = spawnSync(
      process.execPath,
      [new URL('./runner/index.ts', import.meta.url).pathname, ...args],
      { encoding: 'utf8', timeout: 10000 },
    );
    expect(result.status).toBe(2);
    expect(result.stderr.trim()).toBe(expected);
  }
});
