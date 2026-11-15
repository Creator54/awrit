import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import config from '../../config.js';
import { findBinary } from '../adb/adbControl';
import { buildBrowserBindings } from '../browserBindings';
import { applyBindingRemaps, validateBindingRemap } from '../browserShortcutSettings';
import {
  ANDROID_ACTION_LABELS,
  ANDROID_ACTIONS,
  askDesignKey,
  keyLabel,
  MODIFIER_LETTER,
  type ModifierName,
  readAndroidKeys,
  readBindingRemaps,
  readDesignKey,
  readLeaderKey,
  readModifier,
  saveAndroidKeys,
  saveBindingRemaps,
  saveDesignKey,
  saveLeaderKey,
  saveModifier,
} from '../designKey';
import { describeKeyBindings } from '../keybindings';
import { groupShortcuts, shortcutKeyText, type ShortcutBinding } from '../shortcutReference';
import { type BrowsingPreference, contextGuidance } from './contextGuidance';
import { type DiscoveryReceipt, setupClaudeDiscovery } from './discovery';
import {
  isPiExtensionInstalled,
  type SetupPiExtensionReceipt,
  setupPiExtension,
} from './extensions/piAwrit';
import { applyInstructionsBlock, type BlockChange } from './instructionsBlock';
import { type Exec, type PluginSetupReceipt, setupPlugins, uninstallPlugins } from './pluginSetup';

/** Agents that read a plain instructions file. */
export const INSTRUCTION_AGENTS = [
  'codex',
  'opencode',
  'pi',
  'kiro',
  'kimchi',
  'agy',
  'cmd',
  'kimi',
] as const;
export type InstructionAgent = (typeof INSTRUCTION_AGENTS)[number];
export type SetupItemId = 'claude' | InstructionAgent;

export const LABELS: Record<SetupItemId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  kiro: 'Kiro',
  kimchi: 'Kimchi',
  agy: 'Antigravity (agy)',
  cmd: 'Command Code',
  kimi: 'Kimi Code',
};

const DESCRIPTIONS: Record<SetupItemId, string> = {
  claude: 'Plugin and startup instructions',
  codex: 'Awrit instructions in .codex/AGENTS.md',
  opencode: 'Awrit instructions in opencode/AGENTS.md',
  pi: 'Awrit instructions and feedback extension in .pi/agent/',
  kiro: 'Awrit instructions in .kiro/steering/awrit.md',
  kimchi: 'Awrit instructions in kimchi/harness/agent/AGENTS.md',
  agy: 'Awrit instructions in .gemini/config/AGENTS.md',
  cmd: 'Awrit instructions in .commandcode/AGENTS.md',
  kimi: 'Awrit instructions in .kimi-code/AGENTS.md',
};

export { DESCRIPTIONS };

/** The executable that shows an agent is installed. */
const BINARY: Record<InstructionAgent, string> = {
  codex: 'codex',
  opencode: 'opencode',
  pi: 'pi',
  kiro: 'kiro-cli',
  kimchi: 'kimchi',
  agy: 'agy',
  cmd: 'cmd',
  kimi: 'kimi',
};

export type PromptItem = {
  id: SetupItemId;
  label: string;
  hint?: string;
  description?: string;
};

export type SelectManyFn = (
  prompt: string,
  choices: string[],
  options?: { preselectAll?: boolean; items?: PromptItem[] },
) => string[] | Promise<string[] | null> | null;

export interface SetupFlowOptions {
  home: string;
  env: NodeJS.ProcessEnv;
  launcher: string;
  skillPath: string;
  root?: string;
  dryRun: boolean;
  yes: boolean;
  uninstall: boolean;
  interactive: boolean;
  selectMany: SelectManyFn;
  browsing?: BrowsingPreference;
  selectOne?: (
    prompt: string,
    choices: string[],
    options?: { defaultChoice?: string; items?: import('./prompt').PromptItem[] },
  ) => Promise<string | null> | string | null;
  /** Asks for text with a default; null when cancelled. Without it, setup keeps the saved feedback key. */
  /** Where the feedback key is saved; defaults to the Awrit data directory. */
  settingsFile?: string;
  askText?: (title: string, defaultValue: string) => Promise<string | null>;
  exec?: Exec;
  /** True when `bin` is on PATH. */
  onPath?: (bin: string) => boolean;
}

export type ClaudeSetupResult = {
  plugin: PluginSetupReceipt;
  discovery: DiscoveryReceipt;
};

export type PiSetupResult = BlockChange & {
  extension?: SetupPiExtensionReceipt;
};

export type SetupResults = {
  claude: ClaudeSetupResult;
  pi?: PiSetupResult;
} & Record<Exclude<InstructionAgent, 'pi'>, BlockChange>;

export interface SetupFlowReceipt {
  dryRun: boolean;
  uninstall: boolean;
  selected: SetupItemId[];
  unavailable: SetupItemId[];
  browsing?: BrowsingPreference;
  shortcuts?: ShortcutBinding[];
  results: Partial<SetupResults>;
}

const defaultOnPath = (bin: string): boolean => path.isAbsolute(findBinary(bin));

export function instructionsFile(id: InstructionAgent, home: string, env: NodeJS.ProcessEnv) {
  const config = env.XDG_CONFIG_HOME ?? path.join(home, '.config');
  switch (id) {
    case 'codex':
      return path.join(env.CODEX_HOME ?? path.join(home, '.codex'), 'AGENTS.md');
    case 'pi':
      return path.join(env.PI_CODING_AGENT_DIR ?? path.join(home, '.pi', 'agent'), 'AGENTS.md');
    case 'opencode':
      return path.join(config, 'opencode', 'AGENTS.md');
    case 'kiro':
      // Kiro loads every file in steering/, so Awrit gets its own file instead of editing a shared one.
      return path.join(home, '.kiro', 'steering', 'awrit.md');
    case 'kimchi':
      return path.join(
        env.KIMCHI_CODING_AGENT_DIR ?? path.join(config, 'kimchi', 'harness', 'agent'),
        'AGENTS.md',
      );
    case 'agy':
      return path.join(home, '.gemini', 'config', 'AGENTS.md');
    case 'cmd':
      return path.join(home, '.commandcode', 'AGENTS.md');
    case 'kimi':
      return path.join(env.KIMI_CODE_HOME ?? path.join(home, '.kimi-code'), 'AGENTS.md');
  }
}

export function isConfigured(id: SetupItemId, home: string, env: NodeJS.ProcessEnv): boolean {
  if (id === 'claude') {
    const installed = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
    let hasPlugin = false;
    try {
      if (existsSync(installed)) {
        const data = JSON.parse(readFileSync(installed, 'utf8'));
        hasPlugin = Boolean(data.plugins && 'awrit-chat@awrit' in data.plugins);
      }
    } catch {}

    const settings = path.join(home, '.claude', 'settings.json');
    let hasHook = false;
    try {
      if (existsSync(settings)) {
        hasHook = readFileSync(settings, 'utf8').includes('# awrit-managed:v1');
      }
    } catch {}

    return hasPlugin || hasHook;
  }

  const file = instructionsFile(id, home, env);
  let hasInstructions = false;
  try {
    if (existsSync(file)) {
      hasInstructions = readFileSync(file, 'utf8').includes('<!-- awrit:begin');
    }
  } catch {}

  if (id === 'pi') {
    return hasInstructions || isPiExtensionInstalled(home, env);
  }

  return hasInstructions;
}

export async function setupAll(o: SetupFlowOptions): Promise<SetupFlowReceipt> {
  if (!o.yes && !o.interactive)
    throw new Error('Interactive setup needs a TTY; pass --yes to run non-interactively');
  let browsingPreference: BrowsingPreference = o.browsing ?? 'useful';
  const onPath = o.onPath ?? defaultOnPath;
  const present = {
    claude: onPath('claude') || existsSync(path.join(o.home, '.claude')),
    ...Object.fromEntries(
      INSTRUCTION_AGENTS.map((id) => [
        id,
        onPath(BINARY[id]) || existsSync(path.dirname(instructionsFile(id, o.home, o.env))),
      ]),
    ),
  } as Record<SetupItemId, boolean>;

  const ids = Object.keys(LABELS) as SetupItemId[];
  const candidates = o.uninstall
    ? ids.filter((id) => present[id] && isConfigured(id, o.home, o.env))
    : ids.filter((id) => present[id]);
  const available = candidates;
  const unavailable = ids.filter((id) => !present[id]);
  let selected = available;

  if (!o.yes && available.length > 0) {
    const promptItems: PromptItem[] = available.map((id) => {
      const configured = isConfigured(id, o.home, o.env);
      return {
        id,
        label: LABELS[id],
        hint: configured ? 'configured' : 'not configured',
        description: DESCRIPTIONS[id],
      };
    });
    const choices = available.map((id) => LABELS[id]);
    const picked = await o.selectMany(
      o.uninstall ? 'Choose agents to remove Awrit from' : 'Choose agents to set up',
      choices,
      {
        preselectAll: false,
        items: promptItems,
      },
    );
    selected = available.filter(
      (id, i) =>
        picked?.includes(id) || picked?.includes(choices[i]) || picked?.includes(LABELS[id]),
    );
  }

  if (!o.uninstall && !o.yes && selected.length > 0 && o.browsing === undefined) {
    const browsingItems: import('./prompt').PromptItem[] = [
      {
        id: 'useful',
        label: 'When useful (recommended)',
        description: 'Use the visible viewer for browsing and research when available',
      },
      {
        id: 'always',
        label: 'Always when browsing',
        description: 'Prefer a visible browser whenever supported',
      },
      { id: 'asked', label: 'Only when asked', description: 'Show the browser only when asked' },
    ];
    let picked: string | null = null;
    if (o.selectOne) {
      picked = await o.selectOne(
        'When should agents show web pages?',
        browsingItems.map((b) => b.label),
        { defaultChoice: 'useful', items: browsingItems },
      );
    } else {
      const { selectPrompt } = await import('./prompt');
      picked = await selectPrompt({
        title: 'When should agents show web pages?',
        items: browsingItems,
        defaultId: 'useful',
      });
    }
    if (picked === null) {
      return { dryRun: o.dryRun, uninstall: o.uninstall, selected: [], unavailable, results: {} };
    }
    const matched = browsingItems.find((b) => b.id === picked || b.label === picked);
    browsingPreference = (matched?.id as BrowsingPreference) ?? 'useful';
  }

  const savedModifier = readModifier(o.settingsFile);
  const savedDesignKey = readDesignKey(o.settingsFile);
  // A saved custom design key survives a modifier change; otherwise it follows the modifier.
  const customDesignKey = savedDesignKey !== `<${MODIFIER_LETTER[savedModifier]}-d>`;
  let modifier = savedModifier;
  let designKey = savedDesignKey;
  let leaderKey = readLeaderKey(o.settingsFile);
  let androidKeys = readAndroidKeys(o.settingsFile);
  if (!o.uninstall && !o.yes && selected.length > 0) {
    const modifierItems: import('./prompt').PromptItem[] = [
      {
        id: 'alt',
        label: 'Alt',
        description: 'Alt+T new tab, Alt+W close, Alt+N/P next/prev, Alt+1-9 jump',
      },
      {
        id: 'ctrl',
        label: 'Ctrl',
        description: 'Ctrl+T new tab, Ctrl+W close, Ctrl+N/P next/prev, Ctrl+1-9 jump',
      },
      {
        id: 'super',
        label: 'Super / Cmd',
        description: 'Super+T new tab, Super+W close, Super+N/P next/prev, Super+1-9 jump',
      },
    ];
    const selectOneHelper = async (
      title: string,
      items: import('./prompt').PromptItem[],
      defaultId?: string,
    ): Promise<string | null> => {
      if (o.selectOne) {
        const raw = await o.selectOne(
          title,
          items.map((m) => m.label),
          { defaultChoice: defaultId, items },
        );
        if (raw === null) return null;
        const match = items.find(
          (i) =>
            i.id === raw ||
            i.label === raw ||
            i.label.toLowerCase().startsWith(raw.toLowerCase()),
        );
        return match ? match.id : (defaultId ?? raw);
      }
      const { selectPrompt } = await import('./prompt');
      return selectPrompt({
        title,
        items,
        defaultId,
      });
    };

    let pickedMod: string | null = null;
    pickedMod = await selectOneHelper('Shortcut modifier key:', modifierItems, savedModifier);
    if (!pickedMod) {
      return {
        dryRun: o.dryRun,
        uninstall: o.uninstall,
        selected: [],
        unavailable,
        results: {},
      };
    }
    const chosen = (pickedMod as ModifierName) ?? modifier;
    modifier = chosen;
    if (!customDesignKey) designKey = `<${MODIFIER_LETTER[chosen]}-d>`;
  }

  const savedRemaps = readBindingRemaps(o.settingsFile);
  const bindingRemaps = { ...savedRemaps };

  if (!o.uninstall && !o.yes && selected.length > 0) {
    const selectOneHelper = async (
      title: string,
      items: import('./prompt').PromptItem[],
      defaultId?: string,
    ): Promise<string | null> => {
      if (o.selectOne) {
        const raw = await o.selectOne(
          title,
          items.map((m) => m.label),
          { defaultChoice: defaultId, items },
        );
        if (raw === null) return null;
        const match = items.find(
          (i) =>
            i.id === raw ||
            i.label === raw ||
            i.label.toLowerCase().startsWith(raw.toLowerCase()),
        );
        return match ? match.id : (defaultId ?? raw);
      }
      const { selectPrompt } = await import('./prompt');
      return selectPrompt({
        title,
        items,
        defaultId,
      });
    };

    const shortcutChoice = await selectOneHelper(
      'Shortcuts — keep current or customize',
      [
        { id: 'keep', label: 'Keep current shortcuts', description: 'Use existing shortcut bindings' },
        { id: 'customize', label: 'Customize shortcuts', description: 'Review and customize key bindings' },
      ],
      'keep',
    );
    if (shortcutChoice === null) {
      return {
        dryRun: o.dryRun,
        uninstall: o.uninstall,
        selected: [],
        unavailable,
        results: {},
      };
    }

    if (shortcutChoice === 'customize') {
      const ask = o.askText;
      const say = (message: string) => process.stdout.write(`${message}\n`);
      let base = buildBrowserBindings(config, { modifier, designKey, leaderKey, bindingRemaps: {} });
      let effective = applyBindingRemaps(base, bindingRemaps);
      let cancelled = false;

      categoryLoop: while (true) {
        const curDescribed = describeKeyBindings(Object.entries(effective).map(([key, action]) => ({ key, action })));
        const curGroups = groupShortcuts(curDescribed);

        const categoryItems: import('./prompt').PromptItem[] = [
          { id: 'done', label: 'Done', description: 'Finish customizing shortcuts' },
          ...curGroups.map((g) => ({
            id: g.name,
            label: g.name,
            description: `${g.items.length} action${g.items.length === 1 ? '' : 's'}`,
          })),
          { id: 'android', label: 'Android', description: 'Android leader and navigation keys, feedback key' },
        ];

        const pickedCat = await selectOneHelper('Shortcuts', categoryItems, 'done');
        if (!pickedCat) cancelled = true;
        if (!pickedCat || pickedCat === 'done') {
          break;
        }

        if (pickedCat === 'android') {
          while (true) {
            const androidActionItems: import('./prompt').PromptItem[] = [
              { id: 'done', label: 'Done', description: 'Back to categories' },
              { id: 'feedback', label: `Design feedback — ${shortcutKeyText(designKey)}`, description: 'Feedback key' },
              { id: 'leader', label: `Android leader key — ${shortcutKeyText(leaderKey)}`, description: 'Prefix for Android shortcuts' },
              ...ANDROID_ACTIONS.map((action) => ({
                id: `android:${action}`,
                label: `Android ${ANDROID_ACTION_LABELS[action]} — ${shortcutKeyText(leaderKey)} ${androidKeys[action]}`,
                description: `Android ${ANDROID_ACTION_LABELS[action]} key`,
              })),
            ];

            const pickedAndroid = await selectOneHelper('Shortcuts', androidActionItems, 'done');
            if (!pickedAndroid) { cancelled = true; break categoryLoop; }
            if (pickedAndroid === 'done') {
              break;
            }

            if (ask) {
              if (pickedAndroid === 'feedback') {
                designKey = await askDesignKey({
                  purpose: 'Feedback key, opens design feedback',
                  current: designKey,
                  avoid: [leaderKey],
                  ask,
                  say,
                });
              } else if (pickedAndroid === 'leader') {
                leaderKey = await askDesignKey({
                  purpose: 'Leader key, then a letter opens a viewer shortcut',
                  current: leaderKey,
                  allowSingleKey: true,
                  avoid: [designKey],
                  ask,
                  say,
                });
              } else if (pickedAndroid.startsWith('android:')) {
                const action = pickedAndroid.slice('android:'.length) as (typeof ANDROID_ACTIONS)[number];
                const chosen = { ...androidKeys };
                chosen[action] = await askDesignKey({
                  purpose: `Android ${ANDROID_ACTION_LABELS[action]} key after leader`,
                  allowSingleKey: true,
                  avoid: [
                    leaderKey,
                    designKey,
                    ...ANDROID_ACTIONS.filter((other) => other !== action).map((other) => chosen[other]),
                  ],
                  current: chosen[action],
                  ask,
                  say,
                });
                androidKeys = chosen;
              }
            }
          }
          base = buildBrowserBindings(config, { modifier, designKey, leaderKey, bindingRemaps: {} });
          effective = applyBindingRemaps(base, bindingRemaps);
          continue;
        }

        while (true) {
          const freshDescribed = describeKeyBindings(Object.entries(effective).map(([key, action]) => ({ key, action })));
          const freshGroups = groupShortcuts(freshDescribed);
          const freshGroup = freshGroups.find((g) => g.name === pickedCat);
          if (!freshGroup) break;

          const actionItems: import('./prompt').PromptItem[] = [
            { id: 'done', label: 'Done', description: 'Back to categories' },
            ...freshGroup.items.map((item, idx) => ({
              id: `act:${idx}:${item.action}`,
              label: `${item.action} — ${item.keys.join(', ')}`,
            })),
          ];

          const pickedActionId = await selectOneHelper('Shortcuts', actionItems, 'done');
          if (!pickedActionId) { cancelled = true; break categoryLoop; }
          if (pickedActionId === 'done') {
            break;
          }

          const actionLabel = pickedActionId.replace(/^act:\d+:/, '');

          const matchingOriginals: { original: string; current: string; label: string }[] = [];
          for (const [original, fn] of Object.entries(base)) {
            if (original === designKey || /<Mouse\d+>/i.test(original)) continue;
            const actionName = fn.displayName || fn.name || 'Browser action';
            const label = groupShortcuts([{ action: actionName, keys: [original] }])[0]?.items[0]?.action ?? actionName;
            if (label === actionLabel) {
              const saved = bindingRemaps[original];
              const current = saved && !effective[original] && effective[saved] ? saved : original;
              matchingOriginals.push({ original, current, label });
            }
          }

          if (matchingOriginals.length === 0) continue;

          let targetBinding: { original: string; current: string; label: string } | undefined;

          if (matchingOriginals.length === 1) {
            targetBinding = matchingOriginals[0];
          } else {
            const aliasItems: import('./prompt').PromptItem[] = [
              { id: 'done', label: 'Done', description: 'Back to actions' },
              ...matchingOriginals.map((b) => ({
                id: b.original,
                label: `${shortcutKeyText(b.current)} (original: ${shortcutKeyText(b.original)})`,
              })),
            ];
            const pickedBinding = await selectOneHelper('Shortcuts', aliasItems, 'done');
            if (!pickedBinding) { cancelled = true; break categoryLoop; }
            if (pickedBinding === 'done') {
              continue;
            }
            targetBinding = matchingOriginals.find((b) => b.original === pickedBinding);
          }

          if (targetBinding && ask) {
            const { original, current, label } = targetBinding;
            for (let attempt = 0; attempt < 3; attempt++) {
              const answer = (
                await ask(
                  `${label} — ${shortcutKeyText(original)} (Enter keeps ${shortcutKeyText(current)})`,
                  '',
                )
              )?.trim();
              if (!answer || answer === current) break;
              const error = validateBindingRemap(effective, current, answer);
              if (error) {
                say(error);
                continue;
              }
              if (answer === original) delete bindingRemaps[original];
              else bindingRemaps[original] = answer;
              effective = applyBindingRemaps(base, bindingRemaps);
              break;
            }
          }
        }
      }
      if (cancelled) return { dryRun: o.dryRun, uninstall: o.uninstall, selected: [], unavailable, results: {} };
      const changes = Object.entries(bindingRemaps).filter(([key, value]) => savedRemaps[key] !== value);
      say(`Shortcut changes: ${changes.length ? changes.map(([key, value]) => `${shortcutKeyText(key)} → ${shortcutKeyText(value)}`).join(', ') : 'no new browser remaps'}`);
      say(`Feedback: ${shortcutKeyText(designKey)}; Android leader: ${shortcutKeyText(leaderKey)}; ${ANDROID_ACTIONS.map(action => `${ANDROID_ACTION_LABELS[action]}: ${shortcutKeyText(androidKeys[action])}`).join(', ')}`);
    }

    const reviewChoice = await selectOneHelper(
      'Review & apply',
      [
        { id: 'apply', label: 'Apply', description: 'Apply configuration changes' },
        { id: 'cancel', label: 'Cancel', description: 'Discard changes and exit' },
      ],
      'apply',
    );
    if (!reviewChoice || reviewChoice === 'cancel') {
      return {
        dryRun: o.dryRun,
        uninstall: o.uninstall,
        selected: [],
        unavailable,
        results: {},
      };
    }
  }

  if (!o.dryRun) {
    if (modifier !== savedModifier) saveModifier(modifier, o.settingsFile);
    if (JSON.stringify(bindingRemaps) !== JSON.stringify(savedRemaps)) saveBindingRemaps(bindingRemaps, o.settingsFile);
    if (designKey !== savedDesignKey) saveDesignKey(designKey, o.settingsFile);
    if (leaderKey !== readLeaderKey(o.settingsFile)) saveLeaderKey(leaderKey, o.settingsFile);
    if (JSON.stringify(androidKeys) !== JSON.stringify(readAndroidKeys(o.settingsFile)))
      saveAndroidKeys(androidKeys, o.settingsFile);
  }

  const results: SetupFlowReceipt['results'] = {};
  for (const id of selected) {
    if (id === 'claude') {
      let pluginReceipt: PluginSetupReceipt = {
        installed: false,
        dryRun: o.dryRun,
        commands: [],
      };
      if (o.uninstall) {
        pluginReceipt = await uninstallPlugins({
          root: o.root ?? '',
          dryRun: o.dryRun,
          yes: true,
          interactive: true,
          exec: o.exec,
        });
      } else {
        if (!o.root) throw new Error('Plugin root is missing; run through the Awrit launcher');
        pluginReceipt = await setupPlugins({
          root: o.root,
          dryRun: o.dryRun,
          yes: true,
          interactive: true,
          select: () => null,
          exec: o.exec,
        });
      }
      const discoveryReceipt = setupClaudeDiscovery({
        home: o.home,
        launcher: o.launcher,
        skillPath: o.skillPath,
        dryRun: o.dryRun,
        uninstall: o.uninstall,
        browsing: browsingPreference,
      });
      results.claude = {
        plugin: pluginReceipt,
        discovery: discoveryReceipt,
      };
    } else {
      const blockChange = applyInstructionsBlock({
        file: instructionsFile(id, o.home, o.env),
        text: contextGuidance(id, browsingPreference, keyLabel(designKey)),
        dryRun: o.dryRun,
        uninstall: o.uninstall,
      });

      if (id === 'pi') {
        const extReceipt = setupPiExtension({
          home: o.home,
          env: o.env,
          dryRun: o.dryRun,
          uninstall: o.uninstall,
        });
        results.pi = {
          ...blockChange,
          extension: extReceipt,
        };
      } else {
        results[id] = blockChange;
      }
    }
  }
  return {
    dryRun: o.dryRun,
    uninstall: o.uninstall,
    selected,
    unavailable,
    browsing: o.uninstall ? undefined : browsingPreference,
    shortcuts: o.uninstall
      ? undefined
      : describeKeyBindings(
          Object.entries(
            buildBrowserBindings(config, {
              bindingRemaps,
              modifier,
              designKey,
              leaderKey,
            }),
          ).map(([key, action]) => ({ key, action })),
        ),
    results,
  };
}

const DONE = { create: 'installed', update: 'updated', remove: 'removed', unchanged: 'unchanged' };
const WOULD = {
  create: 'would install',
  update: 'would update',
  remove: 'would remove',
  unchanged: 'unchanged',
};

/** Plain-text summary for people; `--json` prints the receipt instead. */
export function formatSetupSummary(r: SetupFlowReceipt): string {
  const isTTY = Boolean(process.stdout.isTTY);
  const cyan = isTTY ? '\x1b[36m' : '';
  const green = isTTY ? '\x1b[32m' : '';
  const yellow = isTTY ? '\x1b[33m' : '';
  const dim = isTTY ? '\x1b[2m' : '';
  const bold = isTTY ? '\x1b[1m' : '';
  const reset = isTTY ? '\x1b[0m' : '';

  const verbs = r.dryRun ? WOULD : DONE;
  const lines: string[] = [];

  const formatStatus = (status: string) => {
    if (status === 'installed' || status.includes('installed')) {
      return `${green}${status}${reset}`;
    }
    if (status === 'removed' || status.includes('removed')) {
      return `${yellow}${status}${reset}`;
    }
    if (status === 'unchanged' || status.includes('unchanged')) {
      return `${dim}${status}${reset}`;
    }
    return status;
  };

  const add = (id: SetupItemId, status: string, detail?: string) => {
    const detailText = detail ? ` ${dim}(${detail})${reset}` : '';
    lines.push(
      `${cyan}│${reset}  ${dim}•${reset} ${bold}${LABELS[id]}${reset}: ${formatStatus(status)}${detailText}`,
    );
  };

  for (const id of r.selected) {
    if (id === 'claude') {
      const res = r.results.claude;
      if (!res) continue;
      if (r.uninstall && res.plugin) {
        if (res.plugin.dryRun) {
          add(id, 'would run plugin uninstall');
          for (const c of res.plugin.commands) {
            lines.push(`${cyan}│${reset}    ${dim}${c.join(' ')}${reset}`);
          }
        } else {
          add(id, 'plugin uninstalled');
        }
      } else if (!r.uninstall && res.plugin) {
        if (res.plugin.dryRun) {
          add(id, 'would run plugin install');
          for (const c of res.plugin.commands) {
            lines.push(`${cyan}│${reset}    ${dim}${c.join(' ')}${reset}`);
          }
        } else {
          add(id, res.plugin.installed ? 'plugin installed' : 'plugin unchanged');
        }
      }
      for (const c of res.discovery?.changes ?? []) {
        const kindLabel =
          c.kind === 'hook'
            ? 'startup instructions'
            : c.kind === 'skill'
              ? 'agent instructions'
              : c.kind;
        add(id, `${kindLabel} ${verbs[c.action]}`, c.path);
      }
    } else {
      const c = r.results[id];
      if (!c) continue;
      add(id, `instructions ${verbs[c.action]}`, c.path);
      if (id === 'pi' && (c as any).extension) {
        const ext = (c as any).extension as SetupPiExtensionReceipt;
        if (ext.action !== 'unchanged') {
          add(id, `extension ${verbs[ext.action]}`, ext.path);
        }
      }
      if (r.dryRun && c.block) {
        lines.push(...c.block.split('\n').map((l) => `${cyan}│${reset}    ${dim}${l}${reset}`));
      }
    }
  }

  if (r.selected.length === 0) {
    if (r.uninstall) {
      if (r.unavailable.length === Object.keys(LABELS).length) {
        return `${cyan}◆${reset}  ${dim}Nothing to remove. No agents have Awrit configured.${reset}`;
      }
      return `${dim}No agents selected. No changes made.${reset}`;
    }
    return `${dim}Cancelled or nothing selected. No changes made.${reset}`;
  }

  const title = r.dryRun
    ? 'Dry run. No changes made.'
    : r.uninstall
      ? 'Removal finished.'
      : 'Setup finished.';

  const out: string[] = [];
  out.push(`${green}✔${reset}  ${bold}${title}${reset}`);
  out.push(`${cyan}│${reset}`);
  if (!r.uninstall && r.browsing && r.selected.length > 0) {
    const BROWSING_LABELS: Record<BrowsingPreference, string> = {
      useful: 'When useful',
      always: 'Always when browsing',
      asked: 'Only when asked',
    };
    lines.unshift(
      `${cyan}│${reset}  ${cyan}Browsing:${reset} ${BROWSING_LABELS[r.browsing] ?? r.browsing}`,
    );
  }
  out.push(...lines);

  if (r.unavailable.length > 0) {
    out.push(`${cyan}│${reset}`);
    out.push(
      `${cyan}│${reset}  ${dim}Skipped (not found): ${r.unavailable.map((id) => LABELS[id]).join(', ')}${reset}`,
    );
  }
  if (!r.uninstall && r.selected.length > 0) {
    out.push(`${cyan}│${reset}`);
    if (!r.dryRun) {
      out.push(
        `${cyan}│${reset}  ${dim}Next:${reset} ${bold}Start a new agent session and ask "show me the app".${reset}`,
      );
    }
    const shortcutGroups = groupShortcuts(r.shortcuts ?? []);
    if (shortcutGroups.length) {
      const help = shortcutGroups
        .find((group) => group.name === 'Help')
        ?.items.find((item) => item.action === 'Keyboard shortcuts');
      out.push(`${cyan}│${reset}`);
      out.push(
        `${cyan}│${reset}  ${bold}Keyboard shortcuts${reset}${help ? ` — ${help.keys[0]} opens Help` : ''}`,
      );
      out.push(
        `${cyan}│${reset}  ${dim}Defaults for new viewers; custom config may differ.${reset}`,
      );
      for (const group of shortcutGroups) {
        out.push(`${cyan}│${reset}  ${bold}${group.name}${reset}`);
        for (const item of group.items)
          out.push(`${cyan}│${reset}    ${item.action.padEnd(25)} ${item.keys[0]}`);
      }
    }
    out.push(`${cyan}│${reset}  ${dim}Remove:${reset} ${bold}awrit setup --uninstall${reset}`);
  }
  out.push(`${cyan}└${reset}`);
  return out.join('\n');
}
