import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setupClaudeDiscovery } from './discovery';

const realSkill = path.resolve(import.meta.dir, '../../skills/awrit/SKILL.md');
let home: string;
const launcher = "/opt/aw rit/it's/awrit";
const settingsPath = () => path.join(home, '.claude', 'settings.json');
const skillPath = () => path.join(home, '.claude', 'skills', 'awrit', 'SKILL.md');
const run = (extra = {}) =>
  setupClaudeDiscovery({ home, launcher, skillPath: realSkill, ...extra });
const readSettings = () => JSON.parse(readFileSync(settingsPath(), 'utf8'));

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), 'awrit-disc-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const existing = {
  model: 'x',
  hooks: {
    SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo hi' }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'true' }] }],
  },
};

describe('setupClaudeDiscovery', () => {
  test('dry run writes nothing', () => {
    const r = run({ dryRun: true });
    expect(r.changes.map((c) => c.action)).toEqual(['create', 'create']);
    expect(() => readFileSync(skillPath())).toThrow();
    expect(() => readFileSync(settingsPath())).toThrow();
  });

  test('installs, preserves unrelated settings, is idempotent', () => {
    mkdirSync(path.join(home, '.claude'));
    writeFileSync(settingsPath(), JSON.stringify(existing));
    run();
    const first = readFileSync(settingsPath(), 'utf8');
    const s = readSettings();
    expect(s.model).toBe('x');
    expect(s.hooks.Stop).toEqual(existing.hooks.Stop);
    expect(s.hooks.SessionStart).toHaveLength(2);
    expect(s.hooks.SessionStart[0]).toEqual(existing.hooks.SessionStart[0]);
    expect(s.hooks.SessionStart[1].hooks[0].command).toContain(
      `'/opt/aw rit/it'\\''s/awrit' context`,
    );
    expect(run().changes.map((c) => c.action)).toEqual(['unchanged', 'unchanged']);
    expect(readFileSync(settingsPath(), 'utf8')).toBe(first);
  });

  test('uninstall removes only owned entries', () => {
    mkdirSync(path.join(home, '.claude'));
    writeFileSync(settingsPath(), JSON.stringify(existing));
    run();
    const r = run({ uninstall: true });
    expect(r.changes.map((c) => c.action)).toEqual(['remove', 'remove']);
    expect(readSettings()).toEqual(existing);
    expect(() => readFileSync(skillPath())).toThrow();
    expect(run({ uninstall: true }).changes.map((c) => c.action)).toEqual([
      'unchanged',
      'unchanged',
    ]);
  });

  test('uninstall on fresh home creates nothing', () => {
    run({ uninstall: true });
    expect(() => readFileSync(settingsPath())).toThrow();
  });

  test('refuses unowned skill, symlinks, invalid JSON, relative launcher', () => {
    mkdirSync(path.dirname(skillPath()), { recursive: true });
    writeFileSync(skillPath(), 'mine');
    expect(() => run()).toThrow(/unowned/);
    rmSync(skillPath());
    writeFileSync(path.join(home, 'target'), 'x');
    symlinkSync(path.join(home, 'target'), skillPath());
    expect(() => run()).toThrow(/symlink/);
    rmSync(skillPath());
    writeFileSync(settingsPath(), '{bad');
    expect(() => run()).toThrow(/invalid JSON/);
    expect(() => setupClaudeDiscovery({ home, launcher: 'awrit', skillPath: realSkill })).toThrow(
      /absolute/,
    );
  });

  test('settings failure rolls back the skill', () => {
    mkdirSync(path.join(home, '.claude'));
    writeFileSync(settingsPath(), JSON.stringify({ hooks: { SessionStart: 'nope' } }));
    expect(() => run()).toThrow(/not an array/);
    expect(() => readFileSync(skillPath())).toThrow();
  });
});
