import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupKitty } from './kittySetup';

const realKitten = path.resolve(import.meta.dir, '../../kittens/awrit.py');
let root: string;
let dir: string;
let launcher: string;
const run = (extra = {}) =>
  setupKitty({ configDir: dir, kittenPath: realKitten, launcher, ...extra });

beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'kitty-setup-')));
  dir = path.join(root, 'kitty');
  launcher = path.join(root, "aw rit's");
  writeFileSync(launcher, '#!/bin/sh\n');
  chmodSync(launcher, 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('setupKitty', () => {
  test('dry run writes nothing', () => {
    const r = run({ dryRun: true });
    expect(r.changes.map((c) => c.action)).toEqual(['create', 'create', 'create', 'create']);
    expect(() => readdirSync(dir)).toThrow();
  });

  test('installs owned files and a marked include block; idempotent; rest of kitty.conf untouched', () => {
    mkdirOther();
    const r = run();
    expect(r.suggestedMapping).toContain('map alt+d kitten');
    const snippetText = readFileSync(path.join(dir, 'awrit.conf'), 'utf8');
    expect(snippetText).toContain('\nmap alt+d kitten');
    // Other windows keep Kitty's own copy, so plain shells never get the key.
    expect(snippetText).toContain(
      '\nmap --when-focus-on "cmdline:/terminal/main\\.[jt]s or cmdline:tuios or cmdline:tmux" ctrl+shift+c copy_or_noop\n',
    );
    expect(readFileSync(path.join(dir, 'awrit-kitten.py'), 'utf8')).toContain(
      readFileSync(realKitten, 'utf8'),
    );
    expect(run().changes.map((c) => c.action)).toEqual(['unchanged', 'unchanged', 'unchanged', 'unchanged']);
    const conf = readFileSync(path.join(dir, 'kitty.conf'), 'utf8');
    expect(conf.startsWith('map f1 noop\n')).toBe(true);
    expect(conf.match(/^include awrit\.conf$/gm)).toHaveLength(1);
    expect(readdirSync(dir).sort()).toEqual(['awrit-kitten.py', 'awrit.conf', 'awrit_design.py', 'kitty.conf']);
    expect(run({ designKey: '<C-S-d>' }).suggestedMapping).toContain('map ctrl+shift+d kitten');
  });

  test('refuses unowned file and symlink; nothing else written', () => {
    mkdirOther();
    writeFileSync(path.join(dir, 'awrit.conf'), 'mine\n');
    expect(() => run()).toThrow(/unowned/);
    expect(readdirSync(dir)).not.toContain('awrit-kitten.py');
    rmSync(path.join(dir, 'awrit.conf'));
    symlinkSync(realKitten, path.join(dir, 'awrit-kitten.py'));
    expect(() => run()).toThrow(/unowned/);
  });

  test('uninstall removes only owned files', () => {
    mkdirOther();
    run();
    expect(run({ uninstall: true }).changes.map((c) => c.action)).toEqual(['remove', 'remove', 'remove', 'update']);
    expect(readdirSync(dir)).toEqual(['kitty.conf']);
    expect(readFileSync(path.join(dir, 'kitty.conf'), 'utf8')).toBe('map f1 noop\n');
    expect(run({ uninstall: true }).changes.map((c) => c.action)).toEqual([
      'unchanged',
      'unchanged',
      'unchanged',
      'unchanged',
    ]);
  });

  test('rejects bad launcher', () => {
    expect(() => run({ launcher: 'relative' })).toThrow(/absolute/);
    chmodSync(launcher, 0o644);
    expect(() => run()).toThrow();
  });
});

function mkdirOther() {
  require('node:fs').mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'kitty.conf'), 'map f1 noop\n');
}

test('rejects symlinked config directories and multiline launcher hints', () => {
  const actual = path.join(root, 'actual');
  require('node:fs').mkdirSync(actual);
  symlinkSync(actual, dir);
  expect(() => run()).toThrow('unsafe config directory');
  expect(readdirSync(actual)).toEqual([]);
  expect(() =>
    run({ configDir: path.join(root, 'other'), launcher: launcher + '\nmap f1 bad' }),
  ).toThrow('control');
});

test('edits a symlinked regular kitty.conf without replacing the link', () => {
  mkdirOther();
  const real = path.join(root, 'real.conf');
  writeFileSync(real, 'map f1 noop\n');
  rmSync(path.join(dir, 'kitty.conf'));
  symlinkSync(real, path.join(dir, 'kitty.conf'));
  expect(run({ dryRun: true }).changes.at(-1)?.action).toBe('update');
  expect(readFileSync(real, 'utf8')).toBe('map f1 noop\n');
  expect(run().changes.at(-1)?.action).toBe('update');
  expect(lstatSync(path.join(dir, 'kitty.conf')).isSymbolicLink()).toBe(true);
  expect(readFileSync(real, 'utf8')).toContain('include awrit.conf');
  expect(run().changes.at(-1)?.action).toBe('unchanged');
  expect(run({ uninstall: true }).changes.at(-1)?.action).toBe('update');
  expect(readFileSync(real, 'utf8')).toBe('map f1 noop\n');
});

test.skipIf(process.platform !== 'linux')('warns when a resolved target cannot be atomically written', () => {
  mkdirOther();
  rmSync(path.join(dir, 'kitty.conf'));
  symlinkSync('/proc/version', path.join(dir, 'kitty.conf'));
  const before = readFileSync('/proc/version', 'utf8');
  const change = run().changes.at(-1);
  expect(change?.action).toBe('manual');
  expect(change?.warning).toContain('Could not edit /proc/version');
  expect(change?.warning).toContain('Add the include');
  expect(readFileSync('/proc/version', 'utf8')).toBe(before);
  expect(lstatSync(path.join(dir, 'kitty.conf')).isSymbolicLink()).toBe(true);
});

test('warns for a broken config symlink without replacing it', () => {
  mkdirOther();
  rmSync(path.join(dir, 'kitty.conf'));
  symlinkSync(path.join(root, 'missing.conf'), path.join(dir, 'kitty.conf'));
  const change = run().changes.at(-1);
  expect(change?.action).toBe('manual');
  expect(change?.warning).toContain('Could not resolve');
  expect(lstatSync(path.join(dir, 'kitty.conf')).isSymbolicLink()).toBe(true);
});
