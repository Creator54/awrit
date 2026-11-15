import { randomBytes } from 'node:crypto';
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const MARKER = 'awrit-managed: kitty v1';
export const KITTEN_NAME = 'awrit-kitten.py';
export const SNIPPET_NAME = 'awrit.conf';

export interface KittySetupOptions {
  configDir: string;
  kittenPath: string;
  launcher: string;
  /** The user's saved Design key, e.g. `<A-d>`. */
  designKey?: string;
  dryRun?: boolean;
  uninstall?: boolean;
}

export interface KittyChange {
  kind: 'kitten' | 'design-kitten' | 'snippet' | 'kitty-conf';
  path: string;
  /** `manual`: the include could not be edited; warning explains why. */
  warning?: string;
  action: 'create' | 'update' | 'remove' | 'unchanged' | 'manual';
}

export interface KittySetupReceipt {
  dryRun: boolean;
  changes: KittyChange[];
  /** The mapping that setup enabled through its marked include block. */
  suggestedMapping: string;
}

const shQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;

function mapping(kitten: string, launcher: string, designKey: string): string {
  return `env AWRIT_LAUNCHER=${launcher}\nmap ${designKey} kitten ${kitten} design --key ${designKey}`;
}

const KITTY_MODIFIERS: Record<string, string> = { C: 'ctrl', A: 'alt', S: 'shift', M: 'super' };

/** Turns an Awrit key such as `<C-S-d>` into Kitty's `ctrl+shift+d`. */
export function kittyKey(binding: string): string {
  const parts = binding.replace(/^<|>$/g, '').split('-');
  const last = parts.pop() ?? '';
  return [...parts.map((m) => KITTY_MODIFIERS[m] ?? m), last.toLowerCase()].join('+');
}

function snippet(kitten: string, launcher: string, designKey: string): string {
  return `# ${MARKER}
# Loaded by the marked include block that awrit setup kitty keeps in kitty.conf.
# The Design key is your Awrit Design key and works in any split. Uncomment the
# others and pick keys that are free in your config.
# Modes: split, tab, overlay, window. Android: kitten ... tab device view SERIAL
#
env AWRIT_LAUNCHER=${launcher}
map ${designKey} kitten ${kitten} design --key ${designKey}
# Kitty's own copy shortcut otherwise swallows Ctrl+Shift+C before the page sees it.
map --when-focus-on cmdline:/terminal/main\\.(js|ts) ctrl+shift+c send_key ctrl+shift+c
# map ctrl+shift+f9 kitten ${kitten} split https://example.com
# map ctrl+shift+f10 kitten ${kitten} tab https://example.com
`;
}

const BLOCK_START = `# >>> ${MARKER} (remove with: awrit setup kitty --uninstall)`;
const BLOCK_END = `# <<< ${MARKER}`;

/** kitty.conf text with the include block added, or removed when `include` is false. */
export function withIncludeBlock(text: string, include: boolean): string {
  const start = text.indexOf(BLOCK_START);
  const end = start < 0 ? -1 : text.indexOf(BLOCK_END, start);
  let bare = text;
  if (start >= 0 && end >= 0) {
    const before = text.slice(0, start).replace(/\n$/, '');
    const after = text.slice(end + BLOCK_END.length).replace(/^\n/, '');
    bare = before + (before && after ? '\n' : '') + after;
  }
  if (!include) return bare;
  const lead = bare === '' || bare.endsWith('\n') ? '' : '\n';
  return `${bare}${lead}\n${BLOCK_START}\ninclude ${SNIPPET_NAME}\n${BLOCK_END}\n`;
}

/** Current file state: missing, owned (marker present) or foreign. Symlinks are always foreign. */
function inspect(file: string): 'missing' | 'owned' | 'foreign' {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw e;
  }
  if (!st.isFile()) return 'foreign';
  return readFileSync(file, 'utf8').slice(0, 512).includes(MARKER) ? 'owned' : 'foreign';
}

function inspectConf(file: string): 'missing' | 'file' | 'manual' {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw e;
  }
  return info.isSymbolicLink() ? (statSync(file).isFile() ? 'file' : 'manual') : info.isFile() ? 'file' : 'manual';
}

function writeAtomic(file: string, content: string, mode: number): void {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, content, { mode, flag: 'wx' });
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

function requireFile(p: string, what: string, exec = false): string {
  if (!path.isAbsolute(p)) throw new Error(`${what} must be an absolute path: ${p}`);
  if (!statSync(p).isFile()) throw new Error(`${what} is not a file: ${p}`);
  if (exec) accessSync(p, constants.X_OK);
  return p;
}

export function setupKitty(opts: KittySetupOptions): KittySetupReceipt {
  const { configDir, dryRun = false, uninstall = false } = opts;
  const unsafePath = [...(configDir + opts.launcher + opts.kittenPath)].some(
    (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
  );
  if (!path.isAbsolute(configDir) || unsafePath) {
    throw new Error('Setup paths must be absolute and contain no control characters');
  }
  let parent = configDir;
  while (parent !== path.dirname(parent)) {
    try {
      const info = lstatSync(parent);
      if (info.isSymbolicLink() || !info.isDirectory())
        throw new Error(`Refusing unsafe config directory: ${parent}`);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
    parent = path.dirname(parent);
  }

  const kitten = path.join(configDir, KITTEN_NAME);
  const conf = path.join(configDir, SNIPPET_NAME);
  const launcher = opts.launcher; // kitty `env` takes the raw value, no shell quoting
  const kittenArg = shQuote(kitten);
  const designKey = kittyKey(opts.designKey ?? '<A-d>');

  let kittenText = '';
  let designKittenText = '';
  if (!uninstall) {
    requireFile(opts.launcher, 'launcher', true);
    kittenText = `# ${MARKER}\n${readFileSync(requireFile(opts.kittenPath, 'kittenPath'), 'utf8')}`;
    designKittenText = `# ${MARKER}\n${readFileSync(requireFile(path.join(path.dirname(opts.kittenPath), 'awrit_design.py'), 'design kitten'), 'utf8')}`;
  }
  const targets = [
    { kind: 'kitten', file: kitten, text: kittenText, mode: 0o644 },
    { kind: 'design-kitten', file: path.join(configDir, 'awrit_design.py'), text: designKittenText, mode: 0o644 },
    { kind: 'snippet', file: conf, text: snippet(kittenArg, launcher, designKey), mode: 0o644 },
  ] as const;

  // Check every target first so a refusal leaves nothing half-written.
  const plan = targets.map((t) => ({ ...t, state: inspect(t.file) }));
  for (const p of plan) {
    if (p.state === 'foreign') throw new Error(`refusing to touch unowned file: ${p.file}`);
  }

  const changes: KittyChange[] = [];
  const kittyConf = path.join(configDir, 'kitty.conf');
  let confState: ReturnType<typeof inspectConf>;
  let confTarget = kittyConf;
  let warning: string | undefined;
  try {
    confState = inspectConf(kittyConf);
    if (confState === 'file') confTarget = realpathSync(kittyConf);
  } catch (error) {
    confState = 'manual';
    warning = `Could not resolve Kitty config: ${String(error)}`;
  }
  if (!dryRun && !uninstall) mkdirSync(configDir, { recursive: true });
  for (const p of plan) {
    let action: KittyChange['action'] = 'unchanged';
    if (uninstall) {
      if (p.state === 'owned') action = 'remove';
    } else if (p.state === 'missing') action = 'create';
    else if (readFileSync(p.file, 'utf8') !== p.text) action = 'update';
    if (!dryRun && action !== 'unchanged') {
      if (action === 'remove') rmSync(p.file);
      else writeAtomic(p.file, p.text, p.mode);
    }
    changes.push({ kind: p.kind, path: p.file, action });
  }
  // kitty.conf: only the marked block is added or removed; the rest stays byte for byte.
  let current = '';
  if (confState === 'file') {
    try {
      current = readFileSync(confTarget, 'utf8');
    } catch (error) {
      confState = 'manual';
      warning = `Could not read ${confTarget}: ${String(error)}`;
    }
  }
  const next = withIncludeBlock(current, !uninstall);
  let confAction: KittyChange['action'] =
    confState === 'manual'
      ? 'manual'
      : next === current
        ? 'unchanged'
        : uninstall || confState === 'file'
          ? 'update'
          : 'create';
  if (!dryRun && (confAction === 'create' || confAction === 'update')) {
    try {
      // Resolve the target before atomic replacement; never replace the symlink itself.
      writeAtomic(confTarget, next, confState === 'missing' ? 0o644 : statSync(confTarget).mode & 0o777);
    } catch (error) {
      confAction = 'manual';
      warning = `Could not edit ${confTarget}: ${String(error)}`;
    }
  }
  if (confAction === 'manual') warning ??= 'Kitty config is not a regular file.';
  changes.push({ kind: 'kitty-conf', path: kittyConf, action: confAction, ...(warning ? { warning: `${warning} ${uninstall ? 'Remove' : 'Add'} the include awrit.conf block in the managed source configuration, then reload Kitty.` } : {}) });
  return { dryRun, changes, suggestedMapping: mapping(kittenArg, launcher, designKey) };
}
