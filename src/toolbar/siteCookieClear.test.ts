import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/Toolbar.tsx', import.meta.url), 'utf8');

test('cookie clear results update only the site details that started the action', async () => {
  const start = source.lastIndexOf('onClick={()', source.indexOf('.clearSiteCookies('));
  const end = source.indexOf('\n                    >', start);
  const expression = source.slice(start + 'onClick={'.length, end).trim().slice(0, -1);
  let url = 'https://a.example';
  let info: { cookies: number } | null = { cookies: 9 };
  let finish!: (cookies: number) => void;
  let fail!: (error: Error) => void;
  let error = '';
  const targets: string[] = [];
  const click = new Function('window', 'lastCommittedUrl', 'siteInfo', 'setSiteInfo', 'setCookieError', `return (${expression});`)(
    { ipc: { clearSiteCookies: (target: string) => {
      targets.push(target); return new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    } } }, () => url, () => info,
    (update: (value: typeof info) => typeof info) => { info = update(info); },
    (message: string) => { error = message; },
  );
  click();
  url = 'https://b.example'; info = { cookies: 3 };
  finish(0); await Promise.resolve();
  expect(targets).toEqual(['https://a.example']);
  expect(info).toEqual({ cookies: 3 });
  click(); finish(0); await Promise.resolve();
  expect(info).toEqual({ cookies: 0 });
  click();
  info = { cookies: 5 }; // Same URL, but a refreshed or reopened details panel.
  finish(0); await Promise.resolve();
  expect(info).toEqual({ cookies: 5 });
  click(); info = null; finish(0); await Promise.resolve();
  expect(info).toBe(null);
  info = { cookies: 4 };
  click(); fail(new Error('Deletion failed'));
  await Promise.resolve(); await Promise.resolve();
  expect(info).toEqual({ cookies: 4 });
  expect(error).toBe('Could not clear cookies. Some may already be removed.');
  click(); info = { cookies: 8 }; fail(new Error('Stale failure'));
  await Promise.resolve(); await Promise.resolve();
  expect(error).toBe('');
});
