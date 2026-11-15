import { expect, test } from 'bun:test';
import type { WindowView } from './windows';

test('explicit shortcut remaps change runtime and Help metadata without losing aliases', async () => {
  const { buildBrowserBindings } = await import('./browserBindings');
  const reload = Object.assign(() => true, { displayName: 'Reload' });
  const config = { keybindings: { linux: { '<C-r>': reload, r: reload } } };
  const bindings = buildBrowserBindings(config, { platform: 'linux', bindingRemaps: { '<C-r>': '<A-F9>' } });
  expect(bindings['<C-r>']).toBeUndefined();
  expect(bindings['<A-F9>']({ isMac: false })).toBe(true);
  expect(bindings['<A-F9>'].displayName).toBe('refreshPage');
  expect(bindings['<A-F9>'].primaryKey).toBe('<A-F9>');
  expect(bindings.r).toBe(reload);
  expect(buildBrowserBindings(config, { platform: 'linux', bindingRemaps: {} })['<C-r>']).toBeDefined();
});

test('config.js can be imported without electron runtime', async () => {
  const config = await import('../config.js');
  expect(config).toBeDefined();
  expect(config.keybindings).toBeDefined();
});

test('buildBrowserBindings assigns primaryKey and sets Help default to modifier H', async () => {
  const { buildBrowserBindings } = await import('./browserBindings');
  const config = await import('../config.js');

  // Test default modifier (alt) -> Help should default to <A-h>
  const altBindings = buildBrowserBindings(config, { modifier: 'alt', platform: 'linux' });
  expect(altBindings['<A-h>']).toBeDefined();
  expect(altBindings['<A-h>'].primaryKey).toBe('<A-h>');
  expect(altBindings['<A-t>'].primaryKey).toBe('<A-t>');
  expect(altBindings['<A-1>'].primaryKey).toBe('<A-1>');
  expect(altBindings['<C-l>'].primaryKey).toBe('<C-l>');
  expect(altBindings['<C-r>'].primaryKey).toBe('<C-r>');

  // Test ctrl modifier -> Help should default to <C-h>
  const ctrlBindings = buildBrowserBindings(config, { modifier: 'ctrl', platform: 'linux' });
  expect(ctrlBindings['<C-h>']).toBeDefined();
  expect(ctrlBindings['<C-h>'].primaryKey).toBe('<C-h>');
  expect(ctrlBindings['<C-t>'].primaryKey).toBe('<C-t>');

  // Test super modifier -> Help should default to <M-h>
  const superBindings = buildBrowserBindings(config, { modifier: 'super', platform: 'darwin' });
  expect(superBindings['<M-h>']).toBeDefined();
  expect(superBindings['<M-h>'].primaryKey).toBe('<M-h>');
  expect(superBindings['<M-t>'].primaryKey).toBe('<M-t>');
});

test('buildBrowserBindings preserves explicit helpKey and designKey overrides and aliases', async () => {
  const { buildBrowserBindings } = await import('./browserBindings');
  const customConfig = {
    keybindings: {
      linux: { ...(await import('../config.js')).keybindings.linux },
    },
    urlBar: {
      toggleKey: '<C-k>',
      helpToggleKey: '<F2>',
      designToggleKey: '<F3>',
    },
  };

  const bindings = buildBrowserBindings(customConfig, {
    modifier: 'alt',
    platform: 'linux',
    leaderKey: '<Space>',
  });

  // Explicit overrides
  expect(bindings['<C-k>']).toBeDefined();
  expect(bindings['<C-k>'].primaryKey).toBe('<C-k>');
  expect(bindings['<F2>']).toBeDefined();
  expect(bindings['<F2>'].primaryKey).toBe('<F2>');
  expect(bindings['<F3>']).toBeDefined();
  expect(bindings['<F3>'].primaryKey).toBe('<F3>');

  // Aliases preserved
  expect(bindings['<C-t>']).toBeDefined();
  expect(bindings['<A-t>']).toBeDefined();
  expect(bindings['<C-w>']).toBeDefined();
  expect(bindings['<A-w>']).toBeDefined();
  expect(bindings['<C-Tab>']).toBeDefined();
  expect(bindings['<C-PageDown>']).toBeDefined();
  expect(bindings['<A-n>']).toBeDefined();

  // Leader shortcuts
  expect(bindings['<Space>t']).toBeDefined();
  expect(bindings['<Space>h']).toBeDefined();
});

test('buildBrowserBindings dispatches to view methods and fallback injections', async () => {
  const { buildBrowserBindings } = await import('./browserBindings');
  let fallbackCreated = false;
  let fallbackCycled = false;

  const bindings = buildBrowserBindings(
    { keybindings: {} },
    {
      modifier: 'alt',
      createNewWindow: () => {
        fallbackCreated = true;
      },
      cycleFocus: () => {
        fallbackCycled = true;
        return true;
      },
    },
  );

  // When view is missing terminal actions, calls fallback
  const newWindowAction = bindings['<A-t>'];
  newWindowAction({ isMac: false, view: undefined });
  expect(fallbackCreated).toBe(true);

  const cycleAction = bindings['<A-n>'];
  cycleAction({ isMac: false, view: undefined });
  expect(fallbackCycled).toBe(true);

  // When view has terminal actions, calls view
  let viewNewWindowCalled = false;
  const mockView = {
    terminal: {
      actions: {
        newWindow: () => {
          viewNewWindowCalled = true;
        },
      },
    },
  } as unknown as WindowView;

  newWindowAction({ isMac: false, view: mockView });
  expect(viewNewWindowCalled).toBe(true);
});
