import { expect, test } from 'bun:test';
import type { TermEvent } from 'awrit-native-rs';
import { createKeyBindingHandler, loadKeyBindings } from './keybindings';

const key = (code: string): TermEvent => ({
  eventType: 'key',
  keyEvent: { code, down: true, isCharEvent: true, modifiers: [] },
});

test('named keys do not fall through to the plus binding', () => {
  for (const name of ['Tab', 'Enter', 'Delete', 'Left', 'Space']) {
    let invoked = 0;
    loadKeyBindings({
      keybindings: {
        [`<C-${name}>`]: () => {
          invoked++;
          return true;
        },
      },
    });
    const handler = createKeyBindingHandler();
    const event = key(name === 'Enter' ? 'return' : name.toLowerCase());
    if (!event.keyEvent) throw new Error('Missing key event');
    event.keyEvent.modifiers = ['ctrl'];
    handler.handleEvent(event);
    expect(invoked).toBe(1);
    handler.dispose();
  }
});

test('key sequences cannot continue in a different pane', () => {
  let invoked = 0;
  loadKeyBindings({
    keybindings: {
      ab: () => {
        invoked++;
        return true;
      },
    },
  });
  const first = createKeyBindingHandler();
  const second = createKeyBindingHandler();
  first.handleEvent(key('a'));
  second.handleEvent(key('b'));
  expect(invoked).toBe(0);
  first.handleEvent(key('b'));
  expect(invoked).toBe(1);
  first.dispose();
  second.dispose();
});
