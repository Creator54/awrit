import {
  MODIFIER_LETTER,
  type ModifierName,
  readDesignKey,
  readBindingRemaps,
  readLeaderKey,
  readModifier,
} from './designKey';
import type { KeyBindingAction } from './keybindings';
import { applyBindingRemaps } from './browserShortcutSettings';
import type { WindowView } from './windows';

export interface BrowserBindingsConfig {
  keybindings?: Partial<typeof import('../config.js')['keybindings']>;
  urlBar?: { toggleKey?: string; designToggleKey?: string; helpToggleKey?: string };
}

export interface BuildBrowserBindingsOptions {
  bindingRemaps?: Record<string, string>;
  modifier?: ModifierName;
  designKey?: string;
  leaderKey?: string;
  helpKey?: string;
  platform?: NodeJS.Platform;
  createNewWindow?: () => unknown;
  cycleFocus?: () => boolean | undefined;
}

/** One action per tab number, so the key help lists "Go To Tab 3" rather than nine rows of one name. */
function jumpToTab(n: number): KeyBindingAction {
  const action: KeyBindingAction = ({ view }: { isMac?: boolean; view?: WindowView }) =>
    view?.terminal?.actions?.select(n - 1) ?? false;
  action.displayName = `Go to tab ${n}`;
  return action;
}

/**
 * Pure construction function that builds the keybinding dictionary
 * from config and options without loading electron or window runtimes.
 */
export function buildBrowserBindings(
  config: BrowserBindingsConfig,
  options: BuildBrowserBindingsOptions = {},
): Record<string, KeyBindingAction> {
  const bindings: Record<string, KeyBindingAction> = {};
  if (!config.keybindings) return bindings;

  const currentPlatform = options.platform ?? process.platform;

  if (currentPlatform === 'darwin') {
    if (config.keybindings.mac) {
      Object.assign(bindings, config.keybindings.mac);
    }
  } else {
    if (config.keybindings.linux) {
      Object.assign(bindings, config.keybindings.linux);
    }
  }

  // Add common keybindings that exist at top level
  const topLevelKeys = ['<Mouse4>', '<Mouse5>'];
  for (const key of topLevelKeys) {
    const action = config.keybindings[key as '<Mouse4>' | '<Mouse5>'];
    if (action) {
      const wrapped: KeyBindingAction = ({ view }) => {
        if (view) action({ view });
        return undefined;
      };
      wrapped.displayName = action.name;
      bindings[key] = wrapped;
    }
  }

  // Add default system keybindings
  const toggleKey = config.urlBar?.toggleKey || '<C-l>';
  bindings[toggleKey] = function toggleOmnibox({ view }: { isMac?: boolean; view?: WindowView }) {
    view?.toggleOmnibox();
    return undefined;
  };

  bindings['<C-r>'] = function refreshPage({ view }: { isMac?: boolean; view?: WindowView }) {
    view?.reload();
    return true;
  };
  if (currentPlatform === 'darwin') {
    bindings['<M-r>'] = function refreshPage({ view }: { isMac?: boolean; view?: WindowView }) {
      view?.reload();
      return true;
    };
  }

  const designToggleKey = config.urlBar?.designToggleKey || options.designKey || readDesignKey();
  bindings[designToggleKey] = function toggleDesignMode({
    view,
  }: {
    isMac?: boolean;
    view?: WindowView;
  }) {
    view?.toggleDesignMode();
    return undefined;
  };

  const chosenMod = options.modifier ?? readModifier();
  const M = MODIFIER_LETTER[chosenMod] ?? 'A';

  const helpToggleKey = config.urlBar?.helpToggleKey || options.helpKey || `<${M}-h>`;
  bindings[helpToggleKey] = function toggleKeyHelp({
    view,
  }: {
    isMac?: boolean;
    view?: WindowView;
  }) {
    view?.toggleKeyHelp();
    return undefined;
  };


  // Multi-window / tab keybindings
  const createNewWindow = options.createNewWindow;
  bindings[`<${M}-t>`] = function newWindow({ view }: { isMac?: boolean; view?: WindowView }) {
    if (view?.terminal?.actions) view.terminal.actions.newWindow();
    else createNewWindow?.();
    return true;
  };
  bindings['<C-t>'] = bindings[`<${M}-t>`];
  bindings['<A-t>'] = bindings[`<${M}-t>`];

  // Tab cycling
  const cycleFocus = options.cycleFocus;
  bindings[`<${M}-n>`] = function switchWindow({ view }: { isMac?: boolean; view?: WindowView }) {
    return view?.terminal?.actions
      ? view.terminal.actions.cycle()
      : cycleFocus
        ? cycleFocus()
        : undefined;
  };
  bindings['<C-Tab>'] = bindings[`<${M}-n>`];
  bindings['<C-PageDown>'] = bindings[`<${M}-n>`];
  bindings['<A-n>'] = bindings[`<${M}-n>`];

  bindings[`<${M}-p>`] = function previousWindow({ view }: { isMac?: boolean; view?: WindowView }) {
    return view?.terminal?.actions?.cycle(-1) ?? false;
  };
  bindings['<C-S-Tab>'] = bindings[`<${M}-p>`];
  bindings['<C-PageUp>'] = bindings[`<${M}-p>`];
  bindings['<A-p>'] = bindings[`<${M}-p>`];

  // Tab closing
  bindings[`<${M}-w>`] = function closeTab({ view }: { isMac?: boolean; view?: WindowView }) {
    return view?.terminal?.actions?.closeTab() ?? false;
  };
  bindings['<C-w>'] = bindings[`<${M}-w>`];
  bindings['<A-w>'] = bindings[`<${M}-w>`];
  bindings['<C-S-w>'] = bindings[`<${M}-w>`];

  // Tab jump: 1..9 with the chosen modifier, plus Ctrl and Alt
  const primaryTabJumps: string[] = [];
  for (let n = 1; n <= 9; n++) {
    const jumpFn = jumpToTab(n);
    const primaryKey = `<${M}-${n}>`;
    primaryTabJumps.push(primaryKey);
    bindings[primaryKey] = jumpFn;
    bindings[`<C-${n}>`] = jumpFn;
    bindings[`<A-${n}>`] = jumpFn;
  }

  // Leader shortcuts: press the leader key, then one letter.
  const leader = options.leaderKey ?? readLeaderKey();
  if (leader !== designToggleKey) {
    const tabs = (view?: WindowView) => view?.terminal?.actions;
    const leaderActions: Record<string, KeyBindingAction> = {
      t: function newTab({ view }) {
        if (tabs(view)) tabs(view)?.newWindow();
        else createNewWindow?.();
        return true;
      },
      n: function nextTab({ view }) {
        return tabs(view)?.cycle(1) ?? false;
      },
      p: function previousTab({ view }) {
        return tabs(view)?.cycle(-1) ?? false;
      },
      w: function closeTab({ view }) {
        return tabs(view)?.closeTab() ?? false;
      },
      x: function closeTab({ view }) {
        return tabs(view)?.closeTab() ?? false;
      },
      r: function refreshPage({ view }) {
        view?.reload();
        return true;
      },
      d: function toggleDesignMode({ view }) {
        view?.toggleDesignMode();
        return true;
      },
      h: function toggleKeyHelp({ view }) {
        view?.toggleKeyHelp();
        return true;
      },
      l: function toggleOmnibox({ view }) {
        view?.toggleOmnibox();
        return true;
      },
    };
    for (let n = 1; n <= 9; n++) {
      leaderActions[String(n)] = jumpToTab(n);
    }
    for (const [letter, action] of Object.entries(leaderActions)) {
      bindings[`${leader}${letter}`] = action;
    }
  }

  // DevTools
  bindings['<F12>'] = function toggleDevTools({ view }: { isMac?: boolean; view?: WindowView }) {
    view?.toggleDevTools();
    return undefined;
  };
  bindings['<C-S-i>'] = function toggleDevTools({ view }: { isMac?: boolean; view?: WindowView }) {
    view?.toggleDevTools();
    return undefined;
  };

  // Mark preferred keys after compatibility aliases have been assembled.
  const primaryKeys = [
    toggleKey,
    currentPlatform === 'darwin' ? '<M-r>' : '<C-r>',
    designToggleKey,
    helpToggleKey,
    `<${M}-o>`,
    `<${M}-t>`,
    `<${M}-n>`,
    `<${M}-p>`,
    `<${M}-w>`,
    ...primaryTabJumps,
  ];

  for (const key of primaryKeys) {
    if (bindings[key]) {
      bindings[key].primaryKey = key;
    }
  }

  return applyBindingRemaps(bindings, options.bindingRemaps ?? readBindingRemaps());
}
