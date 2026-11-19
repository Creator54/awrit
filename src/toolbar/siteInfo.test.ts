import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/Toolbar.tsx', import.meta.url), 'utf8');

test('pane wheel scrolls the visible address panel', () => {
  const start = source.indexOf('  window.ipc.onScrollSuggestions(');
  const end = source.indexOf('\n  });', start) + '\n  });'.length;
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
  const suggestions = { scrollTop: 0 };
  const siteInfo = { scrollTop: 0 };
  let open = false;
  const scroll = new Function('window', 'suggestionsContainerRef', 'siteInfoPanelRef', 'siteInfoOpen', `${code}; return window.ipc.scroll;`)(
    { ipc: { onScrollSuggestions(this: { scroll?: (delta: number) => void }, handler: (delta: number) => void) { this.scroll = handler; } } },
    suggestions, siteInfo, () => open,
  );
  scroll(12);
  open = true;
  scroll(35);
  expect(suggestions.scrollTop).toBe(12);
  expect(siteInfo.scrollTop).toBe(35);
});

test('site details refresh on navigation and reject closed or superseded replies', async () => {
  const start = source.lastIndexOf('  createEffect(', source.indexOf('window.ipc.getSitePermissions('));
  const end = source.indexOf('\n  const performSearch', start);
  const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));
  const effects: Array<() => void> = [];
  let cleanups: Array<() => void> = [];
  let url = 'https://a.example';
  let open = false;
  let shown: unknown = null;
  let error = 'Previous clear failed';
  const requests: string[] = [];
  const replies: Array<(info: unknown) => void> = [];
  const toggle = new Function('createEffect', 'onCleanup', 'lastCommittedUrl', 'siteInfoOpen',
    'setSiteInfoOpen', 'setSiteInfo', 'setSitePerms', 'setCookieError', 'window', 'inputRef', `${code}; return toggleSiteInfo;`)(
    (fn: () => void) => { effects.push(fn); }, (fn: () => void) => { cleanups.push(fn); },
    () => url, () => open, (value: boolean) => { open = value; },
    (info: unknown) => { shown = info; }, () => {}, (message: string) => { error = message; },
    { ipc: {
      getSitePermissions: () => Promise.resolve({}),
      getSiteInfo: (target: string) => { requests.push(target); return new Promise(resolve => replies.push(resolve)); },
    } }, undefined,
  );
  const refresh = () => {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
    for (const effect of effects) effect();
  };
  toggle(); refresh();
  url = 'https://b.example'; refresh();
  expect(requests).toEqual(['https://a.example', 'https://b.example']);
  expect(shown).toBe(null);
  expect(error).toBe('');
  replies[1]({ cookies: 2 }); await Promise.resolve();
  replies[0]({ cookies: 9 }); await Promise.resolve();
  expect(shown).toEqual({ cookies: 2 });
  url = 'https://c.example'; refresh();
  toggle(); refresh();
  replies[2]({ cookies: 7 }); await Promise.resolve();
  expect(shown).toBe(null);
  expect(requests).toHaveLength(3);
});
