import type { KeyEvent, TermEvent } from 'awrit-native-rs';
import { options } from './args';
import { console_ } from './console';
import type { WindowView } from './windows';

const isMac = process.platform === 'darwin';

export type KeyBindingAction = ((event: {
  isMac: boolean;
  view?: WindowView;
}) => boolean | undefined) & {
  displayName?: string;
  primaryKey?: string;
};

type KeyBinding = {
  keys: string[];
  original: string;
  action: KeyBindingAction;
};

type KeyBindingMap = Map<string, KeyBinding[]>;

const bindings: KeyBindingMap = new Map();
// Long enough to press a second key after a leader.
const TIMEOUT_MS = 1500;

/**
 * Normalizes and parses a keybinding string into a sequence of keys.
 * Example: "<C-w>l" -> ["ctrl+w", "l"]
 */
export function parseKeyBinding(binding: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inSpecial = false;
  let modifiers: string[] = [];

  for (let i = 0; i < binding.length; i++) {
    const char = binding[i];

    if (char === '<' && !inSpecial) {
      inSpecial = true;
      if (current) {
        // Handle plain characters before the bracket
        for (const c of current) {
          const lower = c.toLowerCase();
          if (c !== lower && c.length === 1) {
            parts.push('shift+' + lower);
          } else {
            parts.push(lower);
          }
        }
        current = '';
      }
      continue;
    }

    if (char === '>' && inSpecial) {
      inSpecial = false;
      if (current) {
        // Handle special keys like <C-a> or <Enter>
        const mods = current.split('-');
        let lastPart = mods[mods.length - 1].toLowerCase();

        // Normalize special key names to match awrit-native-rs
        switch (lastPart) {
          case 'cr':
          case 'enter':
            lastPart = 'return';
            break;
          case 'esc':
            lastPart = 'escape';
            break;
          case 'bs':
            lastPart = 'backspace';
            break;
          case 'up':
          case 'down':
          case 'left':
          case 'right':
          case 'home':
          case 'end':
          case 'pageup':
          case 'pagedown':
          case 'tab':
          case 'delete':
          case 'insert':
          case 'space':
            break;
          case 'plus':
            lastPart = '+';
            break;
          case 'minus':
            lastPart = '-';
            break;
        }

        for (const mod of mods.slice(0, -1)) {
          const m = mod.toLowerCase();
          switch (m) {
            case 'c':
              modifiers.push('ctrl');
              break;
            case 'a':
              modifiers.push('alt');
              break;
            case 's':
              modifiers.push('shift');
              break;
            case 'm':
              modifiers.push('meta');
              break;
          }
        }

        if (modifiers.length > 0) {
          const combo = [...new Set(modifiers)].sort().concat(lastPart).join('+');

          parts.push(combo);
          modifiers = [];
        } else {
          parts.push(lastPart);
        }
        current = '';
      }
      continue;
    }

    if (inSpecial) {
      current += char;
    } else {
      const lower = char.toLowerCase();
      if (char !== lower && char.length === 1) {
        parts.push('shift+' + lower);
      } else {
        parts.push(lower);
      }
    }
  }

  if (current) {
    for (const c of current) {
      const lower = c.toLowerCase();
      if (c !== lower && c.length === 1) {
        parts.push('shift+' + lower);
      } else {
        parts.push(lower);
      }
    }
  }

  return parts;
}

/** Normalized key string and modifiers for a key event, matching parseKeyBinding output. */
function normalizeKeyEvent(keyEvent: KeyEvent): { key: string; modifiers: string[] } {
  const { code, modifiers } = keyEvent;
  // Symbols keep shift only when it was explicitly sent, matching parseKeyBinding.
  const matchedModifiers = [
    ...new Set(
      modifiers
        .map((m) => m.toLowerCase())
        .filter((m) => ['ctrl', 'alt', 'shift', 'meta'].includes(m)),
    ),
  ];
  if (/^[A-Z]$/.test(code) && !matchedModifiers.includes('shift')) matchedModifiers.push('shift');
  const sortedModifiers = matchedModifiers.sort();
  const normalizedCode = code.toLowerCase();
  return {
    key:
      sortedModifiers.length > 0 ? [...sortedModifiers, normalizedCode].join('+') : normalizedCode,
    modifiers: sortedModifiers,
  };
}

/** True when a key event starts the given binding, such as "<A-d>". */
export function startsBinding(keyEvent: KeyEvent, binding: string): boolean {
  return parseKeyBinding(binding)[0] === normalizeKeyEvent(keyEvent).key;
}

/**
 * Loads keybindings from a config object
 */
export function loadKeyBindings(config: { keybindings: Record<string, KeyBindingAction> }) {
  // Clear existing bindings
  bindings.clear();
  for (const reset of sequenceResetters) reset();

  // Add new bindings
  for (const [binding, action] of Object.entries(config.keybindings)) {
    const keys = parseKeyBinding(binding);
    const firstKey = keys[0];

    if (!bindings.has(firstKey)) {
      bindings.set(firstKey, []);
    }

    const keyBindings = bindings.get(firstKey);
    if (keyBindings) {
      keyBindings.push({
        keys,
        original: binding,
        action,
      });
    }
  }
}

/**
 * Get all registered keybindings grouped by action name
 */
export function getAllKeyBindings() {
  return describeKeyBindings(
    [...bindings.values()]
      .flat()
      .map((binding) => ({
        key: binding.original,
        action: binding.action,
        normalized: binding.keys.join(' '),
      })),
  );
}

export function describeKeyBindings(
  entries: Array<{ key: string; action: KeyBindingAction; normalized?: string }>,
) {
  const primaryKeys = new Map<string, string>();
  const grouped = new Map<string, Map<string, string>>();

  for (const binding of entries) {
    const actionName = binding.action.displayName || binding.action.name || 'Unknown Action';
    const normalizedSeq = binding.normalized ?? parseKeyBinding(binding.key).join(' ');
    if (binding.action.primaryKey) primaryKeys.set(actionName, binding.action.primaryKey);

    if (!grouped.has(actionName)) {
      grouped.set(actionName, new Map());
    }

    const actionBindings = grouped.get(actionName);
    if (actionBindings && !actionBindings.has(normalizedSeq)) {
      actionBindings.set(normalizedSeq, binding.key);
    }
  }

  return Array.from(grouped.entries()).map(([action, shortcuts]) => ({
    action,
    keys: Array.from(shortcuts.values()).sort((a, b) => a.length - b.length),
    primaryKey: primaryKeys.get(action),
  }));
}

/**
 * Check if a TermEvent matches any keybinding
 */
const sequenceResetters = new Set<() => void>();

export function createKeyBindingHandler() {
  let currentSequence: string[] = [];
  let timeoutId: NodeJS.Timeout | null = null;
  let pendingAction: KeyBindingAction | null = null;

  function reset() {
    currentSequence = [];
    pendingAction = null;
    if (timeoutId) clearTimeout(timeoutId);
    timeoutId = null;
  }
  sequenceResetters.add(reset);
  function handleEvent(event: TermEvent, view?: WindowView): boolean {
    let keyEvent: KeyEvent | undefined;
    if (event.eventType === 'key') {
      keyEvent = event.keyEvent;
    } else if (event.eventType === 'mouse' && event.mouseEvent) {
      const { kind, button } = event.mouseEvent;
      if (kind === 'mouseDown' || kind === 'mouseUp') {
        if (button === 'fourth' || button === 'fifth') {
          const code = button === 'fourth' ? 'Mouse4' : 'Mouse5';
          keyEvent = { code, modifiers: [], down: kind === 'mouseDown', isCharEvent: false };
        }
      }
    }

    if (!keyEvent || !keyEvent.down) {
      return false;
    }

    const { code, modifiers } = keyEvent;
    const normalized = normalizeKeyEvent(keyEvent);
    const key = normalized.key;

    if (options.dev) {
      console_.error('[KeyDebug]', {
        rawCode: code,
        rawMods: modifiers,
        essentialMods: normalized.modifiers,
        matchedKey: key,
        isDown: keyEvent.down,
      });
    }

    // Clear timeout if new key is pressed
    if (timeoutId) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }

    // Add to current sequence
    currentSequence.push(key);

    const checkMatch = (sequence: string[]): boolean | 'prefix' => {
      const firstKey = sequence[0];
      const keyBindings = bindings.get(firstKey);

      if (!keyBindings) return false;

      const matchesPrefix = keyBindings.some(
        (b) =>
          b.keys.length >= sequence.length &&
          b.keys.every((k, i) => i >= sequence.length || k === sequence[i]),
      );

      if (!matchesPrefix) return false;

      const exactMatch = keyBindings.find(
        (b) => sequence.length === b.keys.length && sequence.every((k, i) => k === b.keys[i]),
      );

      const hasLongerBindings = keyBindings.some(
        (b) =>
          b.keys.length > sequence.length &&
          b.keys.every((k, i) => i >= sequence.length || k === sequence[i]),
      );

      if (hasLongerBindings) {
        pendingAction = exactMatch?.action || null;
        timeoutId = setTimeout(() => {
          if (pendingAction) {
            pendingAction({ isMac, view });
          }
          currentSequence = [];
          pendingAction = null;
        }, TIMEOUT_MS);
        return 'prefix';
      }

      if (exactMatch) {
        const handled = exactMatch.action({ isMac, view });
        if (options.dev) {
          console_.error('[KeyAction]', {
            original: exactMatch.original,
            handled,
            inputFocused: view?.inputFocused,
          });
        }
        if (handled === false) {
          currentSequence = [];
          pendingAction = null;
          return false;
        }
        currentSequence = [];
        pendingAction = null;
        return true;
      }

      return 'prefix';
    };

    const result = checkMatch(currentSequence);

    if (result === 'prefix') {
      // When no input is focused and no overlay is active, swallow prefix keys
      // so multi-key sequences like 'gg' don't leak keystrokes to the page.
      const isIdle = view !== undefined && !view.inputFocused;
      const isOverlayActive =
        view?.omniboxVisible || view?.findVisible || view?.keyHelpVisible || view?.designMode;

      if (isIdle && !isOverlayActive) {
        return true;
      }
      return false;
    }

    if (result === false && currentSequence.length > 1) {
      // Mismatch in sequence, try starting a new sequence with the last key
      currentSequence = [key];
      const retryResult = checkMatch(currentSequence);
      return retryResult === true;
    }

    return result === true;
  }

  return {
    handleEvent,
    dispose() {
      reset();
      sequenceResetters.delete(reset);
    },
  };
}

export const { handleEvent } = createKeyBindingHandler();
