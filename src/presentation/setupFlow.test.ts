import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Menu IDs mirror the existing prompt contract; unexpected prompts fail closed.
function menu(choices: string[]) {
  return async (title: string, _labels: string[], options?: { items?: Array<{ id: string; label: string }> }) => {
    if (/modifier/i.test(title)) return 'alt';
    if (title === 'When should agents show web pages?') return 'useful';
    const choice = choices.shift();
    if (choice === undefined) throw new Error(`Unexpected prompt: ${title}`);
    return options?.items?.find(item => item.label.startsWith(choice))?.id ?? choice;
  };
}
import { fzfArgs } from '../picker';
import { offerSetupOnce } from './firstRun';
import { applyInstructionsBlock } from './instructionsBlock';
import {
  formatSetupSummary,
  INSTRUCTION_AGENTS,
  instructionsFile,
  LABELS,
  setupAll,
} from './setupFlow';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'awrit-setup-'));

describe('instructions block', () => {
  test('create, update, preserve, uninstall', () => {
    const file = path.join(tmp(), 'sub', 'AGENTS.md');
    const a = applyInstructionsBlock({ file, text: 'one' });
    expect(a.action).toBe('create');
    expect(applyInstructionsBlock({ file, text: 'one' }).action).toBe('unchanged');
    writeFileSync(file, `# Mine\n\n${readFileSync(file, 'utf8')}\ntail\n`);
    expect(applyInstructionsBlock({ file, text: 'two' }).action).toBe('update');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('# Mine');
    expect(text).toContain('two');
    expect(text).not.toContain('one');
    expect(text).toContain('tail');
    expect(applyInstructionsBlock({ file, text: 'two', uninstall: true }).action).toBe('remove');
    expect(readFileSync(file, 'utf8')).toBe('# Mine\n\ntail\n');
  });
  test('uninstall deletes file that held only the block; dry-run writes nothing', () => {
    const file = path.join(tmp(), 'AGENTS.md');
    expect(applyInstructionsBlock({ file, text: 'x', dryRun: true }).block).toContain('x');
    expect(existsSync(file)).toBe(false);
    applyInstructionsBlock({ file, text: 'x' });
    applyInstructionsBlock({ file, text: 'x', uninstall: true });
    expect(existsSync(file)).toBe(false);
  });
});

function fixture() {
  const home = tmp();
  const skillPath = path.join(home, 'SKILL.md');
  writeFileSync(skillPath, '<!-- awrit-managed: skill v1 -->\nskill\n');
  const calls: string[][] = [];
  const base = {
    home,
    env: {} as NodeJS.ProcessEnv,
    launcher: '/bin/awrit',
    skillPath,
    root: '/r',
    dryRun: false,
    yes: false,
    uninstall: false,
    interactive: true,
    exec: async (f: string, a: string[]) => void calls.push([f, ...a]),
    onPath: () => true,
  };
  return { home, calls, base };
}

describe('setupAll', () => {
  test('dry-run reference previews selected modifier without saving settings', async () => {
    const { home, base } = fixture();
    const settingsFile = path.join(home, 'settings.json');
    writeFileSync(
      settingsFile,
      JSON.stringify({ modifier: 'alt', designKey: '<A-d>', leaderKey: '<A-a>' }),
    );
    const before = readFileSync(settingsFile, 'utf8');
    const receipt = await setupAll({
      ...base,
      dryRun: true,
      settingsFile,
      selectMany: (_prompt, choices) => choices.filter((choice) => /Codex/.test(choice)),
      selectOne: async (prompt) => (/modifier/i.test(prompt) ? 'super' : 'useful'),
    });
    expect(readFileSync(settingsFile, 'utf8')).toBe(before);
    const summary = formatSetupSummary(receipt);
    expect(summary).toContain('Super/Cmd+H opens Help');
    expect(summary).toContain('Super/Cmd+T');
    expect(summary).toContain('Super/Cmd+D');
    expect(summary).toContain('1–9');
    expect(summary).not.toContain('Unknown Action');
  });
  test('multi-select installs only chosen items', async () => {
    const { home, calls, base } = fixture();
    const r = await setupAll({
      ...base,
      selectMany: (_p, c) => c.filter((x) => /Codex|Claude/.test(x)),
    });
    expect(r.selected).toEqual(['claude', 'codex']);
    expect(calls).toHaveLength(2);
    expect(readFileSync(path.join(home, '.codex/AGENTS.md'), 'utf8')).toContain('awrit:begin');
    expect(existsSync(path.join(home, '.config/opencode/AGENTS.md'))).toBe(false);
  });
  test('asks for the shortcut modifier key, saves it and aligns design key in guidance', async () => {
    const { home, base } = fixture();
    const settingsFile = path.join(home, 'settings.json');
    const prompts: string[] = [];
    let call = 0;
    await setupAll({
      ...base,
      settingsFile,
      selectMany: (_p, c) => c.filter((x) => /Codex/.test(x)),
      selectOne: async (prompt) => {
        prompts.push(prompt);
        return call++ === 0 ? 'useful' : 'ctrl';
      },
    });
    expect(prompts.some((p) => /modifier/i.test(p))).toBe(true);
    const saved = JSON.parse(readFileSync(settingsFile, 'utf8'));
    expect(saved.modifier).toBe('ctrl');
    expect(saved.designKey).toBe('<C-d>');
    expect(readFileSync(path.join(home, '.codex/AGENTS.md'), 'utf8')).toContain('presses Ctrl+D');
  });
  test('browser remaps persist, survive rerun, and do not write during dry-run', async () => {
    const { home, base } = fixture();
    const settingsFile = path.join(home, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify({ unrelated: 'preserved' }));
    const run = (dryRun: boolean, change: boolean) => setupAll({
      ...base, settingsFile, dryRun,
      selectMany: (_p, c) => c.filter(x => /Codex/.test(x)),
      selectOne: menu(change ? ['customize', 'Navigation', 'Reload', '<C-r>', 'done', 'done', 'apply'] : ['keep', 'apply']),
      askText: async () => '<A-F9>',
    });
    await run(true, true);
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ unrelated: 'preserved' });
    await run(false, true);
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({ unrelated: 'preserved', bindingRemaps: { '<C-r>': '<A-F9>' } });
    const before = readFileSync(settingsFile, 'utf8');
    await run(false, false);
    expect(readFileSync(settingsFile, 'utf8')).toBe(before);
  });

  test('cancel after customization writes neither settings nor agent instructions', async () => {
    const { home, base } = fixture();
    const settingsFile = path.join(home, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify({ modifier: 'ctrl', unrelated: true }));
    const before = readFileSync(settingsFile, 'utf8');
    const receipt = await setupAll({
      ...base, settingsFile,
      selectMany: (_p, choices) => choices.filter(choice => /Codex/.test(choice)),
      selectOne: menu(['customize', 'android', 'leader', 'done', 'done', 'cancel']),
      askText: async () => 'Alt+B',
    });
    expect(receipt.selected).toEqual([]);
    expect(readFileSync(settingsFile, 'utf8')).toBe(before);
    expect(existsSync(path.join(home, '.codex/AGENTS.md'))).toBe(false);
  });

  test('keeping current shortcuts asks no per-binding questions', async () => {
    const { home, base } = fixture();
    const settingsFile = path.join(home, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify({ modifier: 'ctrl', designKey: '<C-d>' }));
    const before = readFileSync(settingsFile, 'utf8');
    const titles: string[] = [];
    await setupAll({
      ...base,
      settingsFile,
      selectMany: (_p, c) => c.filter((x) => /Codex/.test(x)),
      selectOne: async (prompt) => (/modifier/i.test(prompt) ? 'ctrl' : 'useful'),
      askText: async (title) => {
        titles.push(title);
        return '';
      },
    });
    expect(titles).toEqual([]);
    // Enter everywhere leaves the settings file alone.
    expect(readFileSync(settingsFile, 'utf8')).toBe(before);
  });
  test('empty answers keep the defaults and save the moved design key', async () => {
    const { home, base } = fixture();
    const settingsFile = path.join(home, 'settings.json');
    await setupAll({
      ...base,
      settingsFile,
      selectMany: (_p, c) => c.filter((x) => /Codex/.test(x)),
      selectOne: async (prompt) => (/modifier/i.test(prompt) ? 'ctrl' : 'useful'),
      askText: async () => '',
    });
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({
      modifier: 'ctrl',
      designKey: '<C-d>',
    });
  });
  test('a saved custom design key survives a modifier change', async () => {
    const { home, base } = fixture();
    const settingsFile = path.join(home, 'settings.json');
    writeFileSync(settingsFile, JSON.stringify({ modifier: 'alt', designKey: '<A-f>' }));
    const titles: string[] = [];
    await setupAll({
      ...base,
      settingsFile,
      selectMany: (_p, c) => c.filter((x) => /Codex/.test(x)),
      selectOne: async (prompt) => (/modifier/i.test(prompt) ? 'ctrl' : 'useful'),
      askText: async (title) => {
        titles.push(title);
        return '';
      },
    });
    expect(titles).toEqual([]);
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({
      modifier: 'ctrl',
      designKey: '<A-f>',
    });
  });
  test('a key already in use is rejected and asked again', async () => {
    const { home, base } = fixture();
    const settingsFile = path.join(home, 'settings.json');
    const answers: Record<string, string[]> = { Leader: ['Alt+D', 'Alt+B'] };
    const titles: string[] = [];
    await setupAll({
      ...base,
      settingsFile,
      selectMany: (_p, c) => c.filter((x) => /Codex/.test(x)),
      selectOne: menu(['customize', 'android', 'leader', 'done', 'done', 'apply']),
      askText: async (title) => {
        titles.push(title);
        const queue = Object.entries(answers).find(([prefix]) => title.startsWith(prefix))?.[1];
        return queue ? (queue.shift() ?? '') : '';
      },
    });
    expect(titles.filter((t) => t.startsWith('Leader'))).toHaveLength(2);
    expect(JSON.parse(readFileSync(settingsFile, 'utf8')).leaderKey).toBe('<A-b>');
  });
  test('asks each Android action letter and saves only changed keys', async () => {
    const { home, base } = fixture();
    const settingsFile = path.join(home, 'settings.json');
    const run = (answers: Record<string, string>) => {
      const titles: string[] = [];
      return setupAll({
        ...base,
        settingsFile,
        selectMany: (_p, c) => c.filter((x) => /Codex/.test(x)),
        selectOne: menu(['customize', 'android', 'feedback', 'leader', 'android:controls', 'android:back', 'android:home', 'android:rotate', 'android:screenshot', 'done', 'done', 'apply']),
        askText: async (title) => {
          titles.push(title);
          const action = Object.keys(answers).find((key) => title.startsWith(`Android ${key}`));
          return action ? answers[action] : '';
        },
      }).then(() => titles);
    };

    const dry = await run({});
    expect(dry[0]).toStartWith('Feedback key');
    expect(dry[1]).toStartWith('Leader key');
    expect(dry.slice(2, 7).map((title) => title.split(' ')[1])).toEqual([
      'Controls',
      'Back',
      'Home',
      'Rotate',
      'Screenshot',
    ]);
    expect(existsSync(settingsFile)).toBe(false);

    await run({ Controls: 'z', Screenshot: 'p' });
    expect(JSON.parse(readFileSync(settingsFile, 'utf8'))).toEqual({
      androidKeys: { controls: 'z', back: 'b', home: 'o', rotate: 'r', screenshot: 'p' },
    });
  });

  test('--yes asks nothing; dry run asks but saves nothing', async () => {
    const { home, base } = fixture();
    const settingsFile = path.join(home, 'settings.json');
    await setupAll({
      ...base,
      yes: true,
      settingsFile,
      askText: async () => {
        throw new Error('should not ask');
      },
    });
    const titles: string[] = [];
    await setupAll({
      ...base,
      dryRun: true,
      settingsFile,
      selectMany: (_p, c) => c,
      selectOne: async () => 'useful',
      askText: async (title) => {
        titles.push(title);
        return '';
      },
    });
    expect(titles).toEqual([]);
    expect(existsSync(settingsFile)).toBe(false);
  });
  test('CODEX_HOME respected; --yes selects all; absent CLIs omitted', async () => {
    const { home, base } = fixture();
    const codex = path.join(home, 'cx');
    const r = await setupAll({
      ...base,
      yes: true,
      env: { CODEX_HOME: codex },
      onPath: (b) => b !== 'opencode',
      selectMany: () => {
        throw new Error('no prompt');
      },
    });
    expect(r.unavailable).toEqual(['opencode']);
    expect(existsSync(path.join(codex, 'AGENTS.md'))).toBe(true);
  });
  test('Pi instructions go to PI_CODING_AGENT_DIR and are removable', async () => {
    const { home, base } = fixture();
    const pi = path.join(home, 'pi-agent');
    const env = { PI_CODING_AGENT_DIR: pi };
    const picked = (_p: string, c: string[]) => c.filter((x) => /Pi/.test(x));
    await setupAll({ ...base, env, selectMany: picked });
    expect(readFileSync(path.join(pi, 'AGENTS.md'), 'utf8')).toContain('awrit show PATH');
    expect(existsSync(path.join(pi, 'extensions', 'awrit.ts'))).toBe(true);
    await setupAll({ ...base, env, uninstall: true, selectMany: picked });
    expect(existsSync(path.join(pi, 'AGENTS.md'))).toBe(false);
    expect(existsSync(path.join(pi, 'extensions', 'awrit.ts'))).toBe(false);
  });
  test('every instruction agent gets a block in its own file and can be removed', async () => {
    const { home, base } = fixture();
    const env = { PI_CODING_AGENT_DIR: path.join(home, 'pi-agent') };
    await setupAll({ ...base, env, yes: true, selectMany: () => null });
    const files = INSTRUCTION_AGENTS.map((id) => instructionsFile(id, home, env));
    expect(new Set(files).size).toBe(INSTRUCTION_AGENTS.length);
    for (const f of files) expect(readFileSync(f, 'utf8')).toContain('awrit:begin');
    expect(files.some((f) => f.endsWith(path.join('steering', 'awrit.md')))).toBe(true);
    await setupAll({ ...base, env, yes: true, uninstall: true, selectMany: () => null });
    for (const f of files) expect(existsSync(f)).toBe(false);
  });
  test('dry-run changes nothing and shows block', async () => {
    const { home, calls, base } = fixture();
    const r = await setupAll({ ...base, yes: true, dryRun: true, selectMany: () => null });
    expect(calls).toEqual([]);
    expect(existsSync(path.join(home, '.codex'))).toBe(false);
    expect(JSON.stringify(r.results.codex)).toContain('awrit:end');
  });
  test('uninstall removes block and keeps the rest', async () => {
    const { home, base } = fixture();
    const file = path.join(home, '.codex/AGENTS.md');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, 'keep\n');
    await setupAll({ ...base, yes: true, selectMany: () => null });
    await setupAll({ ...base, yes: true, uninstall: true, selectMany: () => null });
    expect(readFileSync(file, 'utf8')).toBe('keep\n');
  });
  test('non-TTY without --yes refuses', async () => {
    const { base } = fixture();
    await expect(setupAll({ ...base, interactive: false, selectMany: () => null })).rejects.toThrow(
      'TTY',
    );
  });
});

describe('setup preselection and choices', () => {
  const spy = () => {
    const seen: { prompt: string; choices: string[]; options?: { preselectAll?: boolean } }[] = [];
    const selectMany = (
      prompt: string,
      choices: string[],
      options?: { preselectAll?: boolean },
    ): string[] | null => {
      seen.push({ prompt, choices, options });
      return null;
    };
    return { seen, selectMany };
  };
  test('install and uninstall both default to preselectAll: false with status badges', async () => {
    const { base, home } = fixture();
    const a = spy();
    await setupAll({ ...base, selectMany: a.selectMany });
    expect(a.seen[0]?.options).toMatchObject({ preselectAll: false });
    expect(a.seen[0]?.choices).toEqual(Object.values(LABELS));
    expect(a.seen[0]?.options?.items?.some((item) => item.hint === 'not configured')).toBe(true);

    // After configuring codex:
    const codex = path.join(home, '.codex', 'AGENTS.md');
    mkdirSync(path.dirname(codex), { recursive: true });
    writeFileSync(codex, '<!-- awrit:begin -->\nblock\n<!-- awrit:end -->\n');

    const b = spy();
    await setupAll({ ...base, uninstall: true, selectMany: b.selectMany });
    expect(b.seen[0]?.options).toMatchObject({ preselectAll: false });
    expect(b.seen[0]?.choices).toEqual(['Codex']);
  });
  test('cancel changes nothing and says so', async () => {
    const { home, calls, base } = fixture();
    const r = await setupAll({ ...base, selectMany: () => null });
    expect(r.selected).toEqual([]);
    expect(calls).toEqual([]);
    expect(existsSync(path.join(home, '.codex'))).toBe(false);
    const text = formatSetupSummary(r);
    expect(text).toContain('Cancelled or nothing selected. No changes made.');
    expect(text).not.toContain('installed');
  });
  test('no selection on removal reports no agents selected', async () => {
    const { home, base } = fixture();
    const codex = path.join(home, '.codex', 'AGENTS.md');
    mkdirSync(path.dirname(codex), { recursive: true });
    writeFileSync(codex, '<!-- awrit:begin -->\nblock\n<!-- awrit:end -->\n');

    const r = await setupAll({ ...base, uninstall: true, selectMany: () => [] });
    expect(r.selected).toEqual([]);
    const text = formatSetupSummary(r);
    expect(text).toBe('No agents selected. No changes made.');
  });
  test('uninstall when no agents configured reports nothing to remove', async () => {
    const { base } = fixture();
    const r = await setupAll({
      ...base,
      uninstall: true,
      onPath: () => false,
      selectMany: () => [],
    });
    expect(r.selected).toEqual([]);
    const text = formatSetupSummary(r);
    expect(text).toContain('Nothing to remove. No agents have Awrit configured.');
  });
  test('fzf args: bindings and header keys', () => {
    const multiArgs = fzfArgs('Set up', false, true, false);
    expect(multiArgs).toContain('--multi');
    expect(multiArgs.join(' ')).toContain('ctrl-a:select-all');
    expect(multiArgs.join(' ')).toContain('ctrl-d:deselect-all');
    expect(multiArgs).not.toContain('--bind=load:select-all');

    const preselectedArgs = fzfArgs('Set up', false, true, true);
    expect(preselectedArgs).toContain('--bind=load:select-all');
    expect(preselectedArgs.join(' ')).toContain('All selected');

    expect(fzfArgs('X', false, false, true)).not.toContain('--multi');
    expect(fzfArgs('X', false, false, true)).not.toContain('--bind=load:select-all');
  });
});

describe('setup summary', () => {
  test('install: installed, then unchanged on rerun', async () => {
    const { calls, base } = fixture();
    const o = { ...base, selectMany: (_p: string, c: string[]) => c };
    const first = formatSetupSummary(await setupAll(o));
    expect(calls).toHaveLength(2);
    expect(first).toContain('Setup finished.');
    expect(first).toContain('Claude Code: plugin installed');
    expect(first).toContain('Codex: instructions installed');
    expect(first).toContain('Claude Code: agent instructions installed');
    expect(first).toContain('Browsing: When useful');
    expect(first).toContain('Remove: awrit setup --uninstall');
    expect(first).toContain('Next: Start a new agent session and ask "show me the app".');
    const second = formatSetupSummary(await setupAll(o));
    expect(second).toContain('Codex: instructions unchanged');
    expect(second).not.toContain('Codex: instructions installed');
  });
  test('uninstall: removed, plugin note, unavailable listed', async () => {
    const { base } = fixture();
    const all = {
      ...base,
      onPath: (b: string) => b !== 'opencode',
      selectMany: (_p: string, c: string[]) => c,
    };
    await setupAll(all);
    const text = formatSetupSummary(await setupAll({ ...all, uninstall: true }));
    expect(text).toContain('Removal finished.');
    expect(text).toContain('Codex: instructions removed');
    expect(text).toContain('Claude Code: plugin uninstalled');
    expect(text).toContain('Skipped (not found): OpenCode');
    expect(text).not.toContain('Remove: awrit setup --uninstall');
  });
  test('dry-run keeps exact commands and block', async () => {
    const { base } = fixture();
    const r = await setupAll({ ...base, yes: true, dryRun: true, selectMany: () => null });
    const text = formatSetupSummary(r);
    expect(text).toContain('Dry run. No changes made.');
    expect(text).toContain('claude plugin marketplace add /r');
    expect(text).toContain('claude plugin install awrit-chat@awrit');
    expect(text).toContain('instructions would install');
    expect(text).toContain('Remove: awrit setup --uninstall');
    expect(text).not.toContain('Next: Start a new agent session');
    expect(text).toContain('<!-- awrit:begin');
    expect(text).toContain('<!-- awrit:end -->');
    expect(text).not.toContain(': instructions installed');
  });

  test('interactive choice selecting always or asked persists into instruction block and discovery hook', async () => {
    const { home, base } = fixture();
    // Test 'always'
    const rAlways = await setupAll({
      ...base,
      selectMany: (_p, c) => c.filter((x) => /Codex|Claude/.test(x)),
      selectOne: () => 'always',
    });
    expect(rAlways.browsing).toBe('always');
    const codexBlockAlways = readFileSync(path.join(home, '.codex/AGENTS.md'), 'utf8');
    expect(codexBlockAlways).toContain('Use it for all web browsing and research.');
    const claudeSettingsAlways = readFileSync(path.join(home, '.claude/settings.json'), 'utf8');
    expect(claudeSettingsAlways).toContain('--browsing always');

    // Test 'asked'
    const homeAsked = tmp();
    const skillPathAsked = path.join(homeAsked, 'SKILL.md');
    writeFileSync(skillPathAsked, '<!-- awrit-managed: skill v1 -->\nskill\n');
    const rAsked = await setupAll({
      ...base,
      home: homeAsked,
      skillPath: skillPathAsked,
      selectMany: (_p, c) => c.filter((x) => /Codex|Claude/.test(x)),
      selectOne: () => 'asked',
    });
    expect(rAsked.browsing).toBe('asked');
    const codexBlockAsked = readFileSync(path.join(homeAsked, '.codex/AGENTS.md'), 'utf8');
    expect(codexBlockAsked).toContain('Open it only when the user asks');
    const claudeSettingsAsked = readFileSync(path.join(homeAsked, '.claude/settings.json'), 'utf8');
    expect(claudeSettingsAsked).toContain('--browsing asked');
    expect(formatSetupSummary(rAsked)).toContain('Browsing: Only when asked');
  });

  test('user cancel on selectOne aborts writes and returns selected: []', async () => {
    const { home, calls, base } = fixture();
    const r = await setupAll({
      ...base,
      selectMany: (_p, c) => c.filter((x) => /Codex|Claude/.test(x)),
      selectOne: () => null,
    });
    expect(r.selected).toEqual([]);
    expect(calls).toEqual([]);
    expect(existsSync(path.join(home, '.codex'))).toBe(false);
    expect(existsSync(path.join(home, '.claude'))).toBe(false);
  });

  test('--yes skips prompt and defaults to useful', async () => {
    const { home, base } = fixture();
    let selectOneCalled = false;
    const r = await setupAll({
      ...base,
      yes: true,
      selectMany: () => {
        throw new Error('should not call selectMany');
      },
      selectOne: () => {
        selectOneCalled = true;
        return 'always';
      },
    });
    expect(selectOneCalled).toBe(false);
    expect(r.browsing).toBe('useful');
    const codexBlock = readFileSync(path.join(home, '.codex/AGENTS.md'), 'utf8');
    expect(codexBlock).toContain('When it is available, use it for web browsing and research.');
    const claudeSettings = readFileSync(path.join(home, '.claude/settings.json'), 'utf8');
    expect(claudeSettings).toContain('--browsing useful');
  });

  test('--dry-run computes the blocks with browsing rule', async () => {
    const { home, calls, base } = fixture();
    const r = await setupAll({
      ...base,
      dryRun: true,
      selectMany: (_p, c) => c.filter((x) => /Codex/.test(x)),
      selectOne: () => 'always',
    });
    expect(r.dryRun).toBe(true);
    expect(r.browsing).toBe('always');
    expect(calls).toEqual([]);
    expect(existsSync(path.join(home, '.codex'))).toBe(false);
    const codexResult = r.results.codex;
    expect(JSON.stringify(codexResult)).toContain('Use it for all web browsing and research.');
  });

  test('uninstall skips browsing prompt and omits browsing from receipt', async () => {
    const { base } = fixture();
    // First install with codex
    await setupAll({
      ...base,
      yes: true,
    });
    let selectOneCalled = false;
    const r = await setupAll({
      ...base,
      uninstall: true,
      selectMany: (_p, c) => c.filter((x) => /Codex/.test(x)),
      selectOne: () => {
        selectOneCalled = true;
        return 'always';
      },
    });
    expect(selectOneCalled).toBe(false);
    expect(r.browsing).toBeUndefined();
    expect(r.uninstall).toBe(true);
  });
});

describe('first run', () => {
  const run = async (choice: string | null, interactive = true) => {
    const dir = tmp();
    let ran = 0;
    const o = {
      dir,
      interactive,
      select: () => choice,
      runSetup: async () => void ran++,
    };
    await offerSetupOnce(o);
    const saved = existsSync(path.join(dir, 'setup-offered'));
    const second = await offerSetupOnce({ ...o, select: () => 'Set up now' });
    return { ran, second, saved };
  };
  test('set up now runs once and records', async () => {
    expect(await run('Set up now')).toEqual({ ran: 1, second: false, saved: true });
  });
  test("don't ask again records without running", async () => {
    expect(await run("Don't ask again")).toEqual({ ran: 0, second: false, saved: true });
  });
  test('not now asks again; non-TTY never asks', async () => {
    expect((await run('Not now')).saved).toBe(false);
    expect((await run('Set up now', false)).ran).toBe(0);
  });
});
