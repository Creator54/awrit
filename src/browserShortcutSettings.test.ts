import { expect, test } from 'bun:test';
import { applyBindingRemaps, validateBindingRemap } from './browserShortcutSettings';
import type { KeyBindingAction } from './keybindings';

const action: KeyBindingAction = () => true;
const table = { '<C-r>': action, '<Space>t': action, '<A-h>': action };
test('remaps preserve callable actions and reject collisions and malformed syntax', () => {
  expect(validateBindingRemap(table, '<C-r>', '<A-S-r>')).toBeNull();
  expect(validateBindingRemap(table, '<C-r>', '<Space>')).toContain('used');
  expect(validateBindingRemap(table, '<C-r>', '<A-h>')).toContain('used');
  expect(validateBindingRemap(table, '<C-r>', '<Bogus-r>')).toContain('binding');
  const result = applyBindingRemaps(table, { '<C-r>': '<A-S-r>' });
  expect(result['<C-r>']).toBeUndefined();
  expect(result['<A-S-r>']({ isMac: false })).toBe(true);
  expect(result['<Space>t']).toBe(action);
  expect(table['<C-r>']).toBe(action);
});
test('invalid stored maps cannot remove bindings or overwrite actions', () => {
  for (const value of [null, [], 'bad', { '<C-r>': '<A-h>' }, { missing: '<F2>' }, { '<C-r>': 12 }]) {
    expect(Object.keys(applyBindingRemaps(table, value))).toEqual(Object.keys(table));
  }
});
test('primary and alias remaps share effective metadata and support punctuation', () => {
  const shared = Object.assign(() => true, { primaryKey: '<C-r>', displayName: 'Reload' });
  const bindings = { '<C-r>': shared, r: shared };
  const primary = applyBindingRemaps(bindings, { '<C-r>': '<A-.>' });
  expect(primary['<A-.>'].primaryKey).toBe('<A-.>');
  expect(primary.r.primaryKey).toBe('<A-.>');
  const alias = applyBindingRemaps(bindings, { r: '<C-/>' });
  expect(alias['<C-/ >']).toBeUndefined();
  expect(alias['<C-/>'].primaryKey).toBe('<C-r>');
  expect(shared.primaryKey).toBe('<C-r>');
});

test('normalized modifier order and equivalent sequence prefixes collide', () => {
  expect(validateBindingRemap({ '<C-S-r>': action, '<A-h>': action }, '<A-h>', '<S-C-r>')).toContain('used');
  expect(validateBindingRemap({ '<Space>t': action, '<A-h>': action }, '<A-h>', '<Space>tx')).toContain('used');
});
