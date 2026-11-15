import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  askDesignKey,
  DEFAULT_ANDROID_KEYS,
  keyLabel,
  parseDesignKey,
  readAndroidKeys,
  readDesignKey,
  readLeaderKey,
  saveAndroidKeys,
  saveDesignKey,
  saveLeaderKey,
} from './designKey';

describe('parseDesignKey', () => {
  test('accepts friendly and binding forms', () => {
    expect(parseDesignKey('Alt+D')).toEqual({ key: '<A-d>' });
    expect(parseDesignKey('ctrl+shift+F')).toEqual({ key: '<C-S-f>' });
    expect(parseDesignKey('<A-d>')).toEqual({ key: '<A-d>' });
    expect(parseDesignKey('F9')).toEqual({ key: '<F9>' });
  });
  test('rejects keys that would break typing or clash with the viewer', () => {
    for (const bad of ['', 'd', 'Shift+D', 'Alt+', 'Alt+Tab', 'Hyper+D', 'Ctrl+L', 'Alt+H']) {
      expect('error' in parseDesignKey(bad)).toBe(true);
    }
  });
  test('keyLabel reverses the binding', () => {
    expect(keyLabel('<A-d>')).toBe('Alt+D');
    expect(keyLabel('<C-S-f>')).toBe('Ctrl+Shift+F');
    expect(keyLabel('<F9>')).toBe('F9');
  });
});

describe('saved key', () => {
  const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'awrit-key-')), 'settings.json');
  test('defaults when missing or invalid', () => {
    const f = file();
    expect(readDesignKey(f)).toBe('<A-d>');
    writeFileSync(f, '{"designKey":"x"}');
    expect(readDesignKey(f)).toBe('<A-d>');
    writeFileSync(f, 'not json');
    expect(readDesignKey(f)).toBe('<A-d>');
  });
  test('round trips and keeps other settings', () => {
    const f = file();
    writeFileSync(f, '{"other":1}');
    saveDesignKey('<C-S-f>', f);
    expect(readDesignKey(f)).toBe('<C-S-f>');
    expect(JSON.parse(require('node:fs').readFileSync(f, 'utf8')).other).toBe(1);
  });
});

describe('askDesignKey', () => {
  const run = (answers: (string | null)[]) => {
    const said: string[] = [];
    const titles: string[] = [];
    const queue = [...answers];
    return {
      said,
      titles,
      result: askDesignKey({
        current: '<A-d>',
        ask: async (title) => {
          titles.push(title);
          return queue.shift() ?? null;
        },
        say: (m) => said.push(m),
      }),
    };
  };
  test('shows the default and takes a valid answer', async () => {
    const r = run(['Ctrl+Shift+F']);
    expect(await r.result).toBe('<C-S-f>');
    expect(r.titles[0]).toContain('Alt+D');
  });
  test('explains bad input and asks again', async () => {
    const r = run(['d', 'Alt+K']);
    expect(await r.result).toBe('<A-k>');
    expect(r.said).toHaveLength(1);
  });
  test('keeps the current key after three bad answers or a cancel or empty answer', async () => {
    expect(await run(['d', 'e', 'f']).result).toBe('<A-d>');
    expect(await run([null]).result).toBe('<A-d>');
    expect(await run(['']).result).toBe('<A-d>');
    expect(await run(['   ']).result).toBe('<A-d>');
  });
});

describe('leader key', () => {
  test('is stored beside the feedback key without disturbing it', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'awrit-leader-')), 'settings.json');
    expect(readLeaderKey(file)).toBe('<Space>');
    saveDesignKey('<A-g>', file);
    saveLeaderKey('<A-b>', file);
    expect(readLeaderKey(file)).toBe('<A-b>');
    expect(readDesignKey(file)).toBe('<A-g>');
  });

  test('accepts single keys when allowSingleKey is true', () => {
    expect(parseDesignKey('Space', { allowSingleKey: true })).toEqual({ key: '<Space>' });
    expect(parseDesignKey('<Space>', { allowSingleKey: true })).toEqual({ key: '<Space>' });
    expect(parseDesignKey('\\', { allowSingleKey: true })).toEqual({ key: '\\' });
    expect(parseDesignKey(',', { allowSingleKey: true })).toEqual({ key: ',' });
    expect(parseDesignKey('Alt+A', { allowSingleKey: true })).toEqual({ key: '<A-a>' });
  });

  test('setup asks again when the answer repeats a key already in use', async () => {
    const answers = ['Alt+D', 'Alt+B'];
    const said: string[] = [];
    const key = await askDesignKey({
      purpose: 'the leader',
      avoid: ['<A-d>'],
      current: '<A-a>',
      ask: async () => answers.shift() ?? '',
      say: (message) => said.push(message),
    });
    expect(key).toBe('<A-b>');
    expect(said[0]).toContain('already used');
  });
});

describe('android action keys', () => {
  const file = () => path.join(mkdtempSync(path.join(tmpdir(), 'awrit-android-')), 'settings.json');

  test('defaults when missing, unreadable or not an object', () => {
    const f = file();
    expect(readAndroidKeys(f)).toEqual(DEFAULT_ANDROID_KEYS);
    writeFileSync(f, 'not json');
    expect(readAndroidKeys(f)).toEqual(DEFAULT_ANDROID_KEYS);
    writeFileSync(f, '{"androidKeys":[1,2]}');
    expect(readAndroidKeys(f)).toEqual(DEFAULT_ANDROID_KEYS);
  });

  test('keeps valid letters, ignores unknown actions and rejects multi-character values', () => {
    const key = file();
    writeFileSync(key, JSON.stringify({ androidKeys: { back: 'X', home: 'F2', extra: 'q' } }));
    expect(readAndroidKeys(key)).toEqual({ ...DEFAULT_ANDROID_KEYS, back: 'x' });
  });

  test('duplicate and missing values fall back to the defaults', () => {
    const f = file();
    writeFileSync(f, JSON.stringify({ androidKeys: { back: 'c', home: 'c' } }));
    expect(readAndroidKeys(f)).toEqual(DEFAULT_ANDROID_KEYS);
    writeFileSync(f, JSON.stringify({ androidKeys: { back: 'x', home: 'x' } }));
    expect(readAndroidKeys(f)).toEqual({ ...DEFAULT_ANDROID_KEYS, back: 'x' });
  });

  test('round trips and keeps other settings', () => {
    const f = file();
    writeFileSync(f, '{"other":1}');
    saveAndroidKeys({ ...DEFAULT_ANDROID_KEYS, screenshot: 'p' }, f);
    expect(readAndroidKeys(f)).toEqual({ ...DEFAULT_ANDROID_KEYS, screenshot: 'p' });
    expect(JSON.parse(readFileSync(f, 'utf8')).other).toBe(1);
  });
});
