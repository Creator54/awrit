import { parseKeyBinding, type KeyBindingAction } from './keybindings';

type Bindings = Record<string, KeyBindingAction>;
const grammar = /^(?:[^<>\s]|<(?:[CASM]-)*(?:[^<>\s-]|F(?:[1-9]|1[0-2])|Space|Tab|Enter|CR|Esc|BS|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Left|Right|Up|Down|plus|minus)>)+$/i;

export function validateBindingRemap(bindings: Bindings, original: string, replacement: string): string | null {
  if (!grammar.test(replacement)) return 'Use binding notation, for example <A-f> or <Space>t.';
  if (replacement === original) return null;
  const wanted = parseKeyBinding(replacement);
  for (const key of Object.keys(bindings)) {
    if (key === original) continue;
    const other = parseKeyBinding(key);
    if (wanted.slice(0, Math.min(wanted.length, other.length)).every((part, index) => part === other[index]))
      return `${key} is already used (including shortcut prefixes).`;
  }
  return null;
}

/** Ignore stale or unsafe saved entries rather than replacing another action. */
export function applyBindingRemaps(bindings: Bindings, value: unknown): Bindings {
  const result = { ...bindings };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
  for (const [original, replacement] of Object.entries(value)) {
    if (!Object.hasOwn(bindings, original) || typeof replacement !== 'string' || original === replacement) continue;
    if (validateBindingRemap(result, original, replacement)) continue;
    const action = result[original];
    if (!action) continue;
    delete result[original];
    result[replacement] = action;
  }
  // Keep aliases on one wrapper with a single effective primary key. Never
  // mutate config actions: they are shared with other binding assemblies.
  const entries = Object.entries(result);
  const wrappers = new Map<KeyBindingAction, KeyBindingAction>();
  for (const [key, action] of entries) {
    const originalPrimary = action.primaryKey;
    if (!originalPrimary) continue;
    const remappedPrimary = typeof value === 'object' && value !== null
      ? Object.entries(value).find(([original]) => original === originalPrimary)?.[1]
      : undefined;
    const primary = entries.some(([candidate, bound]) => candidate === originalPrimary && bound === action)
      ? originalPrimary
      : typeof remappedPrimary === 'string' && result[remappedPrimary] === action
        ? remappedPrimary
        : entries.find(([, bound]) => bound === action)?.[0];
    if (!primary || primary === originalPrimary) continue;
    let wrapped = wrappers.get(action);
    if (!wrapped) {
      wrapped = event => action(event);
      wrapped.displayName = action.displayName || action.name;
      wrapped.primaryKey = primary;
      wrappers.set(action, wrapped);
    }
    result[key] = wrapped;
  }
  return result;
}
