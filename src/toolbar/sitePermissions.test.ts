import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./src/Toolbar.tsx', import.meta.url), 'utf8');

test('permission lookups cannot show settings from a previous site', async () => {
  const start = source.lastIndexOf('  createEffect(', source.indexOf('window.ipc.getSitePermissions(lastCommittedUrl())'));
  const end = source.indexOf('\n\n  createEffect(', start + 1);
  let effect!: () => void;
  let cleanup: (() => void) | undefined;
  let url = 'https://a.example';
  let shown: Record<string, string> = { camera: 'allow' };
  const pending: Array<(permissions: Record<string, string>) => void> = [];
  new Function('createEffect', 'onCleanup', 'lastCommittedUrl', 'setSitePerms', 'window', source.slice(start, end))(
    (fn: () => void) => { effect = fn; },
    (fn: () => void) => { cleanup = fn; },
    () => url,
    (permissions: Record<string, string>) => { shown = permissions; },
    { ipc: { getSitePermissions: () => new Promise(resolve => pending.push(resolve)) } },
  );
  effect();
  cleanup?.();
  url = 'https://b.example';
  effect();
  expect(shown).toEqual({});
  pending[1]({ camera: 'block' });
  await Promise.resolve();
  pending[0]({ camera: 'allow' });
  await Promise.resolve();
  expect(shown).toEqual({ camera: 'block' });
  cleanup?.();
  url = '';
  effect();
  expect(shown).toEqual({});
});
