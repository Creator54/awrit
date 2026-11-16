import { afterEach, expect, test } from 'bun:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'awrit portable ')); roots.push(root);
  const bin = join(root, 'bin'); const app = join(root, 'lib/awrit');
  mkdirSync(bin, { recursive: true }); mkdirSync(join(app, 'runtime/node/bin'), { recursive: true });
  mkdirSync(join(app, 'runtime/electron'), { recursive: true });
  copyFileSync(resolve('packaging/awrit'), join(bin, 'awrit')); chmodSync(join(bin, 'awrit'), 0o755);
  writeFileSync(join(app, 'package.json'), JSON.stringify({ version: 'test-version' }));
  writeFileSync(join(app, 'runtime/node/bin/node'), '#!/bin/sh\nif [ "$1" = "-p" ]; then echo test-version; exit; fi\nprintf "%s\\n" "$@"\nprintf "owner=%s\\n" "$AWRIT_OWNER_ENTRY"\nprintf "cwd=%s\\n" "$PWD"\n');
  chmodSync(join(app, 'runtime/node/bin/node'), 0o755);
  return { root, bin, app };
}
test('relocated PATH symlink uses private runtime and preserves arguments/cwd', () => {
  const f = fixture(); const links = join(f.root, 'links'); mkdirSync(links); symlinkSync('../bin/awrit', join(links, 'awrit'));
  const run = spawnSync(join(links, 'awrit'), ['show', 'a b', '--json'], { cwd: tmpdir(), encoding: 'utf8' });
  expect(run.status).toBe(0);
  expect(run.stdout.split('\n').slice(0, 4)).toEqual([join(f.app, 'dist/presentation-cli.js'), 'show', 'a b', '--json']);
  expect(run.stdout).toContain(`owner=${f.app}/dist/browserOwner/main.js`);
  expect(run.stdout).toContain(`cwd=${tmpdir()}`);
});
test.each([
  [['device', 'list'], 'android-cli.js'],
  [['device', 'view', 'phone'], 'terminal/main.js'],
  [['--dev', 'device', 'view', 'phone'], 'terminal/main.js'],
  [['--max-size=1280', 'device', 'view', 'phone'], 'terminal/main.js'],
  [['https://example.test'], 'terminal/main.js'],
  [['device', 'view', 'phone', '--host', 'example.test'], 'android-cli.js'],
])('dispatch %j to %s', (args, entry) => {
  const f = fixture(); const run = spawnSync(join(f.bin, 'awrit'), args, { encoding: 'utf8' });
  expect(run.status).toBe(0); expect(run.stdout.split('\n')[0]).toBe(join(f.app, 'dist', entry));
});
test('version needs neither Git nor a runtime build', () => {
  const f = fixture(); const run = spawnSync(join(f.bin, 'awrit'), ['--version'], { encoding: 'utf8' });
  expect(run.status).toBe(0); expect(run.stdout).toBe('awrit test-version\n');
  expect(readFileSync(join(f.bin, 'awrit'), 'utf8')).not.toContain('bun ');
});
