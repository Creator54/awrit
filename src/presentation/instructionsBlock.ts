import { randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const BEGIN = '<!-- awrit:begin (managed by `awrit setup`; do not edit) -->';
const END = '<!-- awrit:end -->';
const BEGIN_PREFIX = '<!-- awrit:begin';

export interface BlockChange {
  path: string;
  action: 'create' | 'update' | 'remove' | 'unchanged';
  /** Exact text managed by awrit (omitted on removal). */
  block?: string;
}

export const instructionsBlock = (text: string): string => `${BEGIN}\n${text.trim()}\n${END}`;

function read(file: string): string | undefined {
  try {
    if (lstatSync(file).isSymbolicLink()) throw new Error(`Refusing symlink: ${file}`);
    return readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** Creates, updates or removes the awrit block in `file`, preserving all other content. */
export function applyInstructionsBlock(opts: {
  file: string;
  text: string;
  dryRun?: boolean;
  uninstall?: boolean;
}): BlockChange {
  const { file, uninstall = false, dryRun = false } = opts;
  const old = read(file);
  const block = instructionsBlock(opts.text);
  const start = old?.indexOf(BEGIN_PREFIX) ?? -1;
  let next: string | undefined;
  let action: BlockChange['action'];
  if (old !== undefined && start >= 0) {
    const end = old.indexOf(END, start);
    if (end < 0 || old.indexOf(BEGIN_PREFIX, start + 1) >= 0)
      throw new Error(`Malformed awrit block in ${file}; fix or remove it manually`);
    const before = old.slice(0, start);
    const after = old.slice(end + END.length);
    if (uninstall) {
      next =
        after.trim() === ''
          ? before.replace(/\n+$/, '\n')
          : (before + after.replace(/^\n/, '')).replace(/\n{3,}/g, '\n\n');
      action = 'remove';
    } else {
      next = before + block + after;
      action = next === old ? 'unchanged' : 'update';
    }
  } else if (uninstall) {
    action = 'unchanged';
  } else {
    const sep = old === undefined || old.trim() === '' ? '' : old.endsWith('\n') ? '\n' : '\n\n';
    next = `${old ?? ''}${sep}${block}\n`;
    action = 'create';
  }
  const change: BlockChange = { path: file, action, ...(uninstall ? {} : { block }) };
  if (dryRun || action === 'unchanged' || next === undefined) return change;
  if (next.trim() === '') {
    rmSync(file);
    return change;
  }
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, next, { flag: 'wx', mode: 0o644 });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return change;
}
