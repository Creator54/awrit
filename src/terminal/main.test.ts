import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

test('non-interactive launch fails before starting an owner or enabling terminal modes', () => {
  const result = spawnSync(process.execPath, [path.join(import.meta.dir, 'main.ts')], {
    encoding: 'utf8',
    timeout: 5000,
    env: {
      ...process.env,
      AWRIT_ELECTRON: '/must-not-start-awrit-owner',
      KITTY_WINDOW_ID: '',
      KITTY_LISTEN_ON: '',
    },
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain('require an interactive terminal');
});

test('missing or failed Electron reports promptly without clearing an uninitialized terminal', () => {
  const script = String.raw`
import os, pty, select, subprocess, sys, tempfile
with tempfile.TemporaryDirectory(prefix='awrit-startup-test-') as root:
    master, slave = pty.openpty()
    env = dict(os.environ, NO_COLOR='1', HOME=root, XDG_CONFIG_HOME=root+'/config', XDG_DATA_HOME=root+'/data', AWRIT_ELECTRON=root+'/missing-electron', AWRIT_OWNER_ENTRY=sys.argv[2])
    if os.environ.get('AWRIT_TEST_EARLY_EXIT'):
        launcher = root+'/failed-electron'
        with open(launcher, 'w') as f: f.write('#!/bin/sh\necho "FATAL sandbox helper misconfigured"\nexit 127\n')
        os.chmod(launcher, 0o700)
        env['AWRIT_ELECTRON'] = launcher
    child = subprocess.Popen([sys.argv[1], sys.argv[3]], stdin=slave, stdout=slave, stderr=slave, env=env)
    output = b''
    while True:
        r, _, _ = select.select([master], [], [], .05)
        if r:
            try:
                chunk = os.read(master, 65536)
                if not chunk: break
                output += chunk
            except OSError: break
        elif child.poll() is not None:
            while select.select([master], [], [], .05)[0]:
                try:
                    chunk = os.read(master, 65536)
                    if not chunk: break
                    output += chunk
                except OSError: break
            break
    child.wait(timeout=3)
    os.close(slave)
    os.close(master)
    assert child.returncode == 1, (child.returncode, output)
    assert (b'exited with code 127' if os.environ.get('AWRIT_TEST_EARLY_EXIT') else b'ENOENT') in output, output
    assert (b'FATAL sandbox helper misconfigured' in output) or not os.environ.get('AWRIT_TEST_EARLY_EXIT'), output
    assert b'\x1b' not in output, output
`;
  for (const earlyExit of [false, true]) {
  const result = spawnSync(
    'python3',
    [
      '-c',
      script,
      process.execPath,
      path.join(import.meta.dir, '../browserOwner/main.ts'),
      path.join(import.meta.dir, 'main.ts'),
    ],
    { encoding: 'utf8', timeout: 10000,
      env: { ...process.env, AWRIT_TEST_EARLY_EXIT: earlyExit ? '1' : '' } },
  );
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  }
});

test('unsupported launch option fails before terminal access', () => {
  const result = spawnSync(process.execPath, [path.join(import.meta.dir, 'main.ts'), '--android', 'list'], {
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.status).toBe(2);
  expect(result.stderr).toContain('Unknown option: --android');
});
