import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/Toolbar.tsx', import.meta.url), 'utf8');

test('a repeated site-info close event cannot reopen the panel', () => {
  const start = source.indexOf('  window.ipc.onCloseSiteInfo(');
  const end = source.indexOf('\n', start);
  let close!: () => void;
  let open = true;
  new Function('window', 'setSiteInfoOpen', 'toggleSiteInfo', 'inputRef', 'omniboxVisible', source.slice(start, end))(
    { ipc: { onCloseSiteInfo: (fn: () => void) => { close = fn; } } },
    (value: boolean) => { open = value; }, () => { open = !open; }, undefined, () => false,
  );
  close(); expect(open).toBe(false);
  close(); expect(open).toBe(false);
});
