export interface ShortcutBinding {
  action: string;
  keys: string[];
  primaryKey?: string;
}
export interface ShortcutGroup {
  name: string;
  items: Array<{ action: string; keys: string[] }>;
}

const groups = ['Navigation', 'Tabs', 'Page', 'Editing', 'Help', 'Advanced'] as const;
const actions: Record<string, [(typeof groups)[number], string]> = {
  toggleOmnibox: ['Navigation', 'Address / search'],
  back: ['Navigation', 'Back'],
  forward: ['Navigation', 'Forward'],
  H: ['Navigation', 'Back'],
  L: ['Navigation', 'Forward'],
  r: ['Navigation', 'Reload'],
  '/': ['Page', 'Find in page'],
  n: ['Page', 'Next match'],
  N: ['Page', 'Previous match'],
  p: ['Page', 'Previous match'],
  '<M-a>': ['Editing', 'Select all'],
  refresh: ['Navigation', 'Reload'],
  refreshPage: ['Navigation', 'Reload'],
  newWindow: ['Tabs', 'New tab'],
  newTab: ['Tabs', 'New tab'],
  switchWindow: ['Tabs', 'Next tab'],
  nextTab: ['Tabs', 'Next tab'],
  previousWindow: ['Tabs', 'Previous tab'],
  previousTab: ['Tabs', 'Previous tab'],
  closeTab: ['Tabs', 'Close tab'],
  toggleDesignMode: ['Page', 'Feedback'],
  find: ['Page', 'Find in page'],
  zoomIn: ['Page', 'Zoom in'],
  zoomOut: ['Page', 'Zoom out'],
  zoomReset: ['Page', 'Reset zoom'],
  toggleDarkMode: ['Page', 'Dark appearance'],
  copy: ['Editing', 'Copy'],
  paste: ['Editing', 'Paste'],
  toggleKeyHelp: ['Help', 'Keyboard shortcuts'],
  blurInput: ['Help', 'Dismiss / leave input'],
  scrollDown: ['Advanced', 'Scroll down'],
  scrollUp: ['Advanced', 'Scroll up'],
  scrollLeft: ['Advanced', 'Scroll left'],
  scrollRight: ['Advanced', 'Scroll right'],
  scrollToTop: ['Advanced', 'Scroll to top'],
  scrollToBottom: ['Advanced', 'Scroll to bottom'],
  scrollHalfPageDown: ['Advanced', 'Scroll half page down'],
  scrollHalfPageUp: ['Advanced', 'Scroll half page up'],
  toggleDevTools: ['Advanced', 'Developer tools'],
  diagnosticCopy: ['Advanced', 'Copy diagnostics'],
  quit: ['Advanced', 'Close viewer'],
};

export function shortcutKeyText(binding: string): string {
  const modifiers: Record<string, string> = { C: 'Ctrl', A: 'Alt', S: 'Shift', M: 'Super/Cmd' };
  const named: Record<string, string> = { minus: '−', plus: '+', Esc: 'Escape', Space: 'Space' };
  return [...binding.matchAll(/<([^>]+)>|(.)/g)]
    .map(([, chord, plain]) => {
      if (!chord) return plain === ' ' ? 'Space' : /^[A-Z]$/.test(plain) ? `Shift+${plain}` : plain;
      const parts = chord.split('-');
      const last = parts.pop() ?? '';
      return [
        ...parts.map((m) => modifiers[m] ?? m),
        named[last] ?? (last.length === 1 ? last.toUpperCase() : last),
      ].join('+');
    })
    .join(' ');
}

/** Uses only effective registered keys; missing/overridden shortcuts never enter the reference. */
export function groupShortcuts(bindings: ShortcutBinding[], query = ''): ShortcutGroup[] {
  const rows = new Map<
    string,
    { group: string; action: string; keys: string[]; preferred: string[] }
  >();
  for (const binding of bindings) {
    const tab = /^Go to tab [1-9]$/i.test(binding.action);
    const [group, action] = tab
      ? ['Tabs', 'Go to tab']
      : (actions[binding.action] ?? ['Advanced', binding.action]);
    const id = `${group}:${action}`;
    const row = rows.get(id) ?? { group, action, keys: [], preferred: [] };
    row.keys.push(...binding.keys);
    if (binding.primaryKey && binding.keys.includes(binding.primaryKey))
      row.preferred.push(binding.primaryKey);
    rows.set(id, row);
  }
  const normalized = query.trim().toLowerCase().replace(/\s+/g, '');
  return groups.flatMap((name) => {
    const items = [...rows.values()]
      .filter((row) => row.group === name)
      .flatMap((row) => {
        let keys = [
          ...new Set([
            ...row.preferred,
            ...row.keys.filter((k) => /^<[^>]+>$/.test(k)),
            ...row.keys,
          ]),
        ].map(shortcutKeyText);
        if (row.action === 'Go to tab') {
          for (const key of [...keys]) {
            if (!key.endsWith('+1')) continue;
            const prefix = key.slice(0, -1);
            if (
              Array.from({ length: 9 }, (_, i) => `${prefix}${i + 1}`).every((k) =>
                keys.includes(k),
              )
            ) {
              keys = keys.flatMap((k) =>
                k === `${prefix}1`
                  ? [`${prefix}1–9`]
                  : Array.from({ length: 9 }, (_, i) => `${prefix}${i + 1}`).includes(k)
                    ? []
                    : [k],
              );
            }
          }
        }
        if (
          !normalized ||
          `${name}${row.action}`.toLowerCase().replace(/\s+/g, '').includes(normalized)
        )
          return [{ action: row.action, keys }];
        const matched = keys.filter((k) =>
          k.toLowerCase().replace(/\s+/g, '').includes(normalized),
        );
        return matched.length ? [{ action: row.action, keys: matched }] : [];
      });
    return items.length ? [{ name, items }] : [];
  });
}
