import { randomBytes } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { BrowsingPreference } from './contextGuidance';

const SKILL_MARKER = '<!-- awrit-managed: skill v1 -->';
const HOOK_MARKER = '# awrit-managed:v1';

export interface DiscoveryOptions {
  home: string;
  launcher: string;
  skillPath: string;
  dryRun?: boolean;
  uninstall?: boolean;
  browsing?: BrowsingPreference;
}

export interface DiscoveryChange {
  kind: 'skill' | 'hook';
  path: string;
  action: 'create' | 'update' | 'remove' | 'unchanged';
}

export interface DiscoveryReceipt {
  dryRun: boolean;
  uninstall: boolean;
  changes: DiscoveryChange[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Refuses symlinks and non-regular files at `p`; returns whether it exists. */
function existsPlain(p: string, dir = false): boolean {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(p);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  if (st.isSymbolicLink()) throw new Error(`Refusing symlink: ${p}`);
  if (dir ? !st.isDirectory() : !st.isFile()) throw new Error(`Unexpected file type: ${p}`);
  return true;
}

function atomicWrite(file: string, content: string, mode: number): void {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, { mode, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function hookCommand(launcher: string, browsing?: BrowsingPreference): string {
  if (!path.isAbsolute(launcher) || /[\0\r\n]/.test(launcher))
    throw new Error('Launcher must be an absolute path without control characters');
  if (browsing) {
    return `'${launcher.replaceAll("'", `'\\''`)}' context --claude --browsing ${browsing} ${HOOK_MARKER}`;
  }
  return `'${launcher.replaceAll("'", `'\\''`)}' context --claude ${HOOK_MARKER}`;
}

const isOwnedHook = (h: unknown): boolean =>
  isObject(h) && typeof h.command === 'string' && h.command.endsWith(HOOK_MARKER);

/** Returns the new settings object and the hook action; throws on unexpected shapes. */
function editSettings(
  settings: Json,
  command: string,
  uninstall: boolean,
): { settings: Json; action: DiscoveryChange['action'] } {
  const hooks = settings.hooks ?? {};
  if (!isObject(hooks)) throw new Error('settings.json "hooks" is not an object');
  const groups = hooks.SessionStart ?? [];
  if (!Array.isArray(groups)) throw new Error('settings.json hooks.SessionStart is not an array');
  for (const g of groups)
    if (!isObject(g) || !Array.isArray(g.hooks))
      throw new Error('settings.json hooks.SessionStart has an unexpected entry');

  let action: DiscoveryChange['action'] = uninstall ? 'unchanged' : 'create';
  const next: unknown[] = [];
  for (const g of groups as Json[]) {
    const inner = g.hooks as unknown[];
    const kept: unknown[] = [];
    for (const h of inner) {
      if (!isOwnedHook(h)) kept.push(h);
      else if (uninstall) action = 'remove';
      else if (action === 'create' && (h as Json).command === command) {
        action = 'unchanged';
        kept.push(h);
      } else if (action === 'create') {
        action = 'update';
        kept.push({ ...(h as Json), command });
      } // duplicate owned entries are dropped
    }
    if (kept.length > 0) next.push({ ...g, hooks: kept });
    else if (inner.length === 0) next.push(g); // not ours to remove
  }
  if (!uninstall && action === 'create') next.push({ hooks: [{ type: 'command', command }] });

  const out: Json = { ...settings };
  const outHooks: Json = { ...hooks };
  if (next.length > 0) outHooks.SessionStart = next;
  else delete outHooks.SessionStart;
  if (Object.keys(outHooks).length > 0) out.hooks = outHooks;
  else delete out.hooks;
  return { settings: out, action };
}

export function setupClaudeDiscovery(opts: DiscoveryOptions): DiscoveryReceipt {
  const dryRun = opts.dryRun ?? false;
  const uninstall = opts.uninstall ?? false;
  if (!path.isAbsolute(opts.home)) throw new Error('home must be an absolute path');

  const claudeDir = path.join(opts.home, '.claude');
  const skillDir = path.join(claudeDir, 'skills', 'awrit');
  const skillFile = path.join(skillDir, 'SKILL.md');
  const settingsFile = path.join(claudeDir, 'settings.json');
  const command = hookCommand(opts.launcher, opts.browsing);

  // Plan everything before touching disk.
  for (const d of [claudeDir, path.dirname(skillDir), skillDir]) existsPlain(d, true);

  const skillExists = existsPlain(skillFile);
  const oldSkill = skillExists ? readFileSync(skillFile, 'utf8') : undefined;
  if (oldSkill !== undefined && !oldSkill.includes(SKILL_MARKER))
    throw new Error(`Refusing to replace unowned file: ${skillFile}`);

  let newSkill: string | undefined;
  if (!uninstall) {
    if (!existsPlain(opts.skillPath)) throw new Error(`Skill source not found: ${opts.skillPath}`);
    newSkill = readFileSync(opts.skillPath, 'utf8');
    if (!newSkill.includes(SKILL_MARKER)) throw new Error('Skill source lacks ownership marker');
  }
  let skillAction: DiscoveryChange['action'];
  if (uninstall) skillAction = skillExists ? 'remove' : 'unchanged';
  else if (!skillExists) skillAction = 'create';
  else skillAction = oldSkill === newSkill ? 'unchanged' : 'update';

  const settingsExists = existsPlain(settingsFile);
  const oldSettingsText = settingsExists ? readFileSync(settingsFile, 'utf8') : undefined;
  let parsed: unknown = {};
  if (oldSettingsText !== undefined) {
    try {
      parsed = JSON.parse(oldSettingsText);
    } catch {
      throw new Error(`Refusing to edit invalid JSON: ${settingsFile}`);
    }
    if (!isObject(parsed)) throw new Error(`settings.json is not an object: ${settingsFile}`);
  }
  const edit = editSettings(parsed as Json, command, uninstall);
  const hookAction = !settingsExists && uninstall ? 'unchanged' : edit.action;

  const receipt: DiscoveryReceipt = {
    dryRun,
    uninstall,
    changes: [
      { kind: 'skill', path: skillFile, action: skillAction },
      { kind: 'hook', path: settingsFile, action: hookAction },
    ],
  };
  if (dryRun) return receipt;

  // Apply: skill first, settings second; roll the skill back if settings fails.
  const skillChanged = skillAction !== 'unchanged';
  if (skillChanged) {
    if (uninstall) {
      rmSync(skillFile);
      try {
        rmdirSync(skillDir);
      } catch {
        // directory holds other files; leave it
      }
    } else {
      mkdirSync(skillDir, { recursive: true });
      atomicWrite(skillFile, newSkill as string, 0o644);
    }
  }
  if (hookAction !== 'unchanged') {
    try {
      mkdirSync(claudeDir, { recursive: true });
      const mode = settingsExists ? lstatSync(settingsFile).mode & 0o777 : 0o600;
      atomicWrite(settingsFile, `${JSON.stringify(edit.settings, null, 2)}\n`, mode);
    } catch (e) {
      if (skillChanged) {
        if (oldSkill === undefined) rmSync(skillFile, { force: true });
        else {
          mkdirSync(skillDir, { recursive: true });
          atomicWrite(skillFile, oldSkill, 0o644);
        }
      }
      throw e;
    }
  }
  return receipt;
}
