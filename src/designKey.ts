import fs from 'node:fs';
import path from 'node:path';
import { getAppDataPath } from './paths';

export const DEFAULT_DESIGN_KEY = '<A-d>';
export const DEFAULT_MODIFIER = 'alt';
export const DEFAULT_LEADER_KEY = '<Space>';

export type ModifierName = 'alt' | 'ctrl' | 'super';
export const MODIFIER_LETTER: Record<ModifierName, string> = {
  alt: 'A',
  ctrl: 'C',
  super: 'M',
};

const MODIFIERS: Record<string, string> = {
  ctrl: 'C',
  control: 'C',
  alt: 'A',
  option: 'A',
  opt: 'A',
  shift: 'S',
  meta: 'M',
  cmd: 'M',
  command: 'M',
  super: 'M',
};
const MODIFIER_NAMES: Record<string, string> = { C: 'Ctrl', A: 'Alt', S: 'Shift', M: 'Meta' };
const MODIFIER_ORDER = ['C', 'A', 'S', 'M'];

/** Keys the viewer already uses; the feedback key must not shadow them. */
const RESERVED = ['<C-l>', '<C-r>', '<M-r>', '<C-t>', '<C-Tab>', '<F12>', '<C-S-i>', '<A-h>'];

export type DesignKeyResult = { key: string } | { error: string };

/** Turns "Alt+D", "Space", "ctrl+shift+f" or "<A-d>" into a binding such as "<A-d>". */
export function parseDesignKey(input: string, options?: { allowSingleKey?: boolean }): DesignKeyResult {
  const text = input.trim();
  if (!text) return { error: 'Type a key such as Space or Alt+D.' };

  if (options?.allowSingleKey) {
    if (text.toLowerCase() === 'space' || text === '<Space>' || text === ' ') {
      return { key: '<Space>' };
    }
    // Single non-alphanumeric punctuation (e.g. '\', ',', ';')
    if (text.length === 1 && !/[a-zA-Z0-9]/.test(text)) {
      return { key: text };
    }
    // Single character/digit
    if (text.length === 1) {
      return { key: text.toLowerCase() };
    }
  }

  const parts = (/^<.+>$/.test(text) ? text.slice(1, -1).split('-') : text.split('+')).filter(Boolean);
  const last = parts.pop();
  if (!last) return { error: 'Type a key such as Alt+D or Space.' };

  const modifiers = new Set<string>();
  for (const part of parts) {
    const mod = MODIFIERS[part.toLowerCase()] ?? (part.length === 1 ? part.toUpperCase() : undefined);
    if (!mod || !MODIFIER_ORDER.includes(mod)) return { error: `Unknown modifier "${part}". Use Ctrl, Alt, Shift or Meta.` };
    modifiers.add(mod);
  }

  const isFunctionKey = /^f([1-9]|1[0-2])$/i.test(last);
  const isSpaceKey = last.toLowerCase() === 'space';
  if (!isFunctionKey && !isSpaceKey && last.length !== 1) return { error: 'End with one letter, digit, Space or F1-F12.' };
  if (!isFunctionKey && !options?.allowSingleKey && modifiers.size === 0) return { error: 'Add Ctrl, Alt or Meta so typing is not affected.' };
  if (!isFunctionKey && modifiers.size === 1 && modifiers.has('S'))
    return { error: 'Shift alone is not enough; add Ctrl, Alt or Meta.' };

  const ordered = MODIFIER_ORDER.filter((m) => modifiers.has(m));
  const normalizedLast = isFunctionKey ? last.toUpperCase() : isSpaceKey ? 'Space' : last.toLowerCase();
  const key = `<${[...ordered, normalizedLast].join('-')}>`;
  if (RESERVED.includes(key)) return { error: `${keyLabel(key)} is already used by the viewer.` };
  return { key };
}

/** "<C-S-f>" becomes "Ctrl+Shift+F", "<Space>" becomes "Space". */
export function keyLabel(binding: string): string {
  if (binding === '<Space>' || binding === ' ') return 'Space';
  if (!binding.startsWith('<') && binding.length === 1) return binding;
  const parts = binding.slice(1, -1).split('-');
  const last = parts.pop() ?? '';
  return [...parts.map((m) => MODIFIER_NAMES[m] ?? m), last.length === 1 ? last.toUpperCase() : last].join('+');
}

const settingsFile = () => path.join(getAppDataPath(), 'settings.json');

function readKey(name: 'designKey' | 'leaderKey', fallback: string, file: string): string {
  try {
    const saved: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))[name];
    if (typeof saved === 'string') {
      const parsed = parseDesignKey(saved, { allowSingleKey: name === 'leaderKey' });
      if ('key' in parsed) return parsed.key;
    }
  } catch {
    // Missing or unreadable settings mean the default.
  }
  return fallback;
}

/** The saved feedback key, or the default when none is saved or the file is unusable. */
export const readDesignKey = (file = settingsFile()) => readKey('designKey', DEFAULT_DESIGN_KEY, file);
/** The key that starts a shortcut such as leader then T for a new tab. */
export const readLeaderKey = (file = settingsFile()) => readKey('leaderKey', DEFAULT_LEADER_KEY, file);
export const ANDROID_ACTIONS = ['controls', 'back', 'home', 'rotate', 'screenshot'] as const;
export type AndroidAction = (typeof ANDROID_ACTIONS)[number];
export const ANDROID_ACTION_LABELS: Record<AndroidAction, string> = {
  controls: 'Controls',
  back: 'Back',
  home: 'Home',
  rotate: 'Rotate',
  screenshot: 'Screenshot',
};
export const DEFAULT_ANDROID_KEYS: Record<AndroidAction, string> = {
  controls: 'c',
  back: 'b',
  home: 'o',
  rotate: 'r',
  screenshot: 's',
};

/** Leader key plus one letter per Android viewer action. */
export type AndroidKeyConfig = { leader: string; keys: Record<AndroidAction, string> };

const KEY_POOL = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** Saved Android action letters: one letter or digit each; the first use of a letter wins. */
export function parseAndroidKeys(value: unknown): Record<AndroidAction, string> {
  const saved = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  const used = new Set<string>();
  const keys = {} as Record<AndroidAction, string>;
  for (const action of ANDROID_ACTIONS) {
    const raw = saved[action];
    const wanted =
      typeof raw === 'string' && raw.length === 1 && KEY_POOL.includes(raw.toLowerCase())
        ? raw.toLowerCase()
        : DEFAULT_ANDROID_KEYS[action];
    let key = wanted;
    if (used.has(key)) key = DEFAULT_ANDROID_KEYS[action];
    if (used.has(key)) key = [...KEY_POOL].find((letter) => !used.has(letter)) ?? key;
    used.add(key);
    keys[action] = key;
  }
  return keys;
}

/** The saved Android action letters, or the defaults when none are saved or the file is unusable. */
export function readAndroidKeys(file = settingsFile()): Record<AndroidAction, string> {
  try {
    return parseAndroidKeys(JSON.parse(fs.readFileSync(file, 'utf8')).androidKeys);
  } catch {
    return { ...DEFAULT_ANDROID_KEYS };
  }
}

/** Leader key and Android action letters for the Android viewer page. */
export function readAndroidKeyConfig(file = settingsFile()): AndroidKeyConfig {
  return { leader: readLeaderKey(file), keys: readAndroidKeys(file) };
}

/** The chosen modifier for browser shortcuts: alt, ctrl, or super. */
export function readModifier(file = settingsFile()): ModifierName {
  try {
    const saved: unknown = JSON.parse(fs.readFileSync(file, 'utf8')).modifier;
    if (saved === 'alt' || saved === 'ctrl' || saved === 'super') return saved;
  } catch {
    // Missing or invalid settings
  }
  return DEFAULT_MODIFIER;
}

function saveKey(name: string, value: unknown, file: string): void {
  let settings: Record<string, unknown> = {};
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Start fresh when there is nothing valid to keep.
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...settings, [name]: value }, null, 2)}\n`);
}

export const saveDesignKey = (key: string, file = settingsFile()) => saveKey('designKey', key, file);
export const saveLeaderKey = (key: string, file = settingsFile()) => saveKey('leaderKey', key, file);
export const saveModifier = (mod: ModifierName, file = settingsFile()) => saveKey('modifier', mod, file);
export const saveAndroidKeys = (keys: Record<AndroidAction, string>, file = settingsFile()) => saveKey('androidKeys', keys, file);

export function readBindingRemaps(file = settingsFile()): Record<string, string> {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8')).bindingRemaps;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch {
    return {};
  }
}

export const saveBindingRemaps = (value: Record<string, string>, file = settingsFile()) => saveKey('bindingRemaps', value, file);

const ATTEMPTS = 3;

/**
 * Asks for the key, showing the current one as the default.
 * Bad input is explained and asked again; after three tries the current key stays.
 */
export async function askDesignKey(options: {
  /** What the key is for, shown in the question. */
  purpose?: string;
  allowSingleKey?: boolean;
  /** Keys the answer must not repeat. */
  avoid?: string[];
  current: string;
  ask: (title: string, defaultValue: string) => Promise<string | null>;
  say: (message: string) => void;
}): Promise<string> {
  const { current, ask, say, avoid = [], purpose = 'Design key', allowSingleKey } = options;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const answer = await ask(`${purpose} (Enter keeps ${keyLabel(current)})`, '');
    if (answer === null || answer.trim() === '') return current;
    const parsed = parseDesignKey(answer, { allowSingleKey });
    if ('key' in parsed && avoid.includes(parsed.key)) say(`${keyLabel(parsed.key)} is already used for something else.`);
    else if ('key' in parsed) return parsed.key;
    else say(parsed.error);
  }
  say(`Keeping ${keyLabel(current)}.`);
  return current;
}
