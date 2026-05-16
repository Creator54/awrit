import type { KeyEvent, TermEvent } from 'awrit-native-rs';
import { options } from './args';
import { console_ } from './console';
import type { WindowView } from './windows';

const isMac = process.platform === 'darwin';

export type KeyBindingAction = ((event: { isMac: boolean; view?: WindowView }) => void) & {
  displayName?: string;
};

type KeyBinding = {
  keys: string[];
  original: string;
  action: KeyBindingAction;
};

type KeyBindingMap = Map<string, KeyBinding[]>;

const bindings: KeyBindingMap = new Map();
let currentSequence: string[] = [];
let timeoutId: NodeJS.Timeout | null = null;
let pendingAction: KeyBindingAction | null = null;

const TIMEOUT_MS = 500;

/**
 * Normalizes and parses a keybinding string into a sequence of keys.
 * Example: "<C-w>l" -> ["ctrl+w", "l"]
 */
function parseKeyBinding(binding: string): string[] {
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
            // These are already correct
            break;
        }
        
        for (const mod of mods.slice(0, -1)) {
          const m = mod.toLowerCase();
          switch (m) {
            case 'c': modifiers.push('ctrl'); break;
            case 'a': modifiers.push('alt'); break;
            case 's': modifiers.push('shift'); break;
            case 'm': modifiers.push('meta'); break;
          }
        }

        if (modifiers.length > 0) {
          let combo = [...new Set(modifiers)].sort().concat(lastPart).join('+');
          
          // Normalize common terminal aliases to canonical forms
          if (combo === 'ctrl+[') combo = 'escape';
          if (combo === 'ctrl+m') combo = 'return';
          if (combo === 'ctrl+i') combo = 'tab';
          if (combo === 'ctrl+h') combo = 'backspace';
          
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

/**
 * Loads keybindings from a config object
 */
export function loadKeyBindings(config: { keybindings: Record<string, KeyBindingAction> }) {
  // Clear existing bindings
  bindings.clear();
  currentSequence = [];
  if (timeoutId) {
    clearTimeout(timeoutId);
    timeoutId = null;
  }

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
  const grouped = new Map<string, Map<string, string>>();
  
  for (const group of bindings.values()) {
    for (const binding of group) {
      const actionName = binding.action.displayName || binding.action.name || 'Unknown Action';
      const normalizedSeq = binding.keys.join(' ');
      
      if (!grouped.has(actionName)) {
        grouped.set(actionName, new Map());
      }
      
      const actionBindings = grouped.get(actionName);
      if (actionBindings && !actionBindings.has(normalizedSeq)) {
        actionBindings.set(normalizedSeq, binding.original);
      }
    }
  }

  return Array.from(grouped.entries()).map(([action, shortcuts]) => ({
    action,
    keys: Array.from(shortcuts.values()).sort((a, b) => a.length - b.length),
  }));
}

/**
 * Check if a TermEvent matches any keybinding
 */
export function handleEvent(event: TermEvent, view?: WindowView): boolean {
  let keyEvent: KeyEvent | undefined;
  if (event.eventType === 'key') {
    keyEvent = event.keyEvent;
  } else if (event.eventType === 'mouse') {
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
  let normalizedCode = code.toLowerCase();
  
  // Filter and normalize modifiers for matching
  let matchedModifiers = modifiers
    .map(m => m.toLowerCase())
    .filter(m => ['ctrl', 'alt', 'shift', 'meta'].includes(m));

  // Terminal Aliases: Normalize common control character aliases
  if (matchedModifiers.includes('ctrl') && matchedModifiers.length === 1) {
    let aliased = false;
    switch (normalizedCode) {
      case '[':
      case 'escape':
        normalizedCode = 'escape';
        aliased = true;
        break;
      case 'm':
      case 'return':
        normalizedCode = 'return';
        aliased = true;
        break;
      case 'i':
      case 'tab':
        normalizedCode = 'tab';
        aliased = true;
        break;
      case 'h':
      case 'backspace':
        normalizedCode = 'backspace';
        aliased = true;
        break;
    }
    if (aliased) {
      matchedModifiers = [];
    }
  }
  
  matchedModifiers = [...new Set(matchedModifiers)];
  
  const isAlpha = /^[a-zA-Z]$/.test(code);
  const isUppercase = isAlpha && code === code.toUpperCase();
  const isSymbol = code.length === 1 && !isAlpha && !/^[0-9]$/.test(code);

  if ((isUppercase || isSymbol) && matchedModifiers.includes('shift')) {
    matchedModifiers = matchedModifiers.filter(m => m !== 'shift');
    if (isUppercase) {
      matchedModifiers.push('shift');
    }
  }
  
  const sortedModifiers = matchedModifiers.sort();
  const key = sortedModifiers.length > 0 ? [...sortedModifiers, normalizedCode].join('+') : normalizedCode;

  if (options.dev) {
    console_.error('[KeyDebug]', {
      rawCode: code,
      rawMods: modifiers,
      essentialMods: matchedModifiers,
      matchedKey: key,
      isDown: keyEvent.down
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
      (b) =>
        sequence.length === b.keys.length &&
        sequence.every((k, i) => k === b.keys[i]),
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
      exactMatch.action({ isMac, view });
      currentSequence = [];
      pendingAction = null;
      return true;
    }

    return 'prefix';
  };

  const result = checkMatch(currentSequence);
  
  if (result === false && currentSequence.length > 1) {
    // Mismatch in sequence, try starting a new sequence with the last key
    currentSequence = [key];
    const retryResult = checkMatch(currentSequence);
    return retryResult === true;
  }

  return result === true;
}
