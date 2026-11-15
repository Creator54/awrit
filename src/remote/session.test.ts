import { describe, expect, test } from 'bun:test';
import type { InputEvent } from './protocol';
import { createSessionRegistry } from './session';

const text = (value: string): InputEvent => ({ kind: 'text', text: value });

function setup() {
  const panes: { url: string; inputs: InputEvent[]; closed: boolean }[] = [];
  const registry = createSessionRegistry({
    now: () => 1_000,
    createPane: (url) => {
      const pane = {
        url,
        inputs: [] as InputEvent[],
        closed: false,
        input(event: InputEvent) {
          pane.inputs.push(event);
        },
        close() {
          pane.closed = true;
        },
      };
      panes.push(pane);
      return pane;
    },
  });
  return { registry, panes };
}

describe('session registry', () => {
  test('create registers a pane and returns a unique id', () => {
    const { registry, panes } = setup();
    const first = registry.create('https://example.com');
    const second = registry.create('https://example.org');
    expect(first).not.toBe(second);
    expect(panes.map((pane) => pane.url)).toEqual(['https://example.com', 'https://example.org']);
  });

  test('bounds live panes before allocation and frees capacity only on stop', () => {
    const { registry, panes } = setup();
    const first = registry.create('https://example.com');
    for (let index = 1; index < 32; index++) registry.create('https://example.com');
    expect(() => registry.create('https://example.org')).toThrow('Remote session limit reached');
    expect(panes).toHaveLength(32);
    registry.attach(first, 'controller');
    registry.detach(first);
    expect(() => registry.create('https://example.org')).toThrow('Remote session limit reached');
    registry.stop(first);
    expect(registry.create('https://example.org')).toBeString();
    expect(panes).toHaveLength(33);
    expect(panes[0]?.closed).toBe(true);
  });

  test('a second controller gets busy until the lease is released', () => {
    const { registry } = setup();
    const id = registry.create('https://example.com');
    expect(registry.attach(id, 'controller-a')).toBe(1);
    expect(registry.attach(id, 'controller-b')).toBe('busy');
    // A live lease is never stolen, not even by the same id.
    expect(registry.attach(id, 'controller-a')).toBe('busy');
    registry.detach(id);
    expect(registry.attach(id, 'controller-b')).toBe(2);
  });

  test('detach keeps the pane alive', () => {
    const { registry, panes } = setup();
    const id = registry.create('https://example.com');
    registry.attach(id, 'controller-a');
    registry.detach(id);
    expect(panes[0]?.closed).toBe(false);
    expect(registry.attach(id, 'controller-a')).toBe(2);
  });

  test('input is accepted only for the current generation and an increasing seq', () => {
    const { registry, panes } = setup();
    const id = registry.create('https://example.com');
    const generation = registry.attach(id, 'controller-a');
    expect(registry.handleInput(id, generation, 5, text('a'))).toBe(true);
    expect(registry.handleInput(id, generation, 5, text('duplicate'))).toBe(false);
    expect(registry.handleInput(id, generation, 4, text('stale'))).toBe(false);
    expect(registry.handleInput(id, generation, 6, text('b'))).toBe(true);
    expect(panes[0]?.inputs.map((event) => (event.kind === 'text' ? event.text : ''))).toEqual([
      'a',
      'b',
    ]);
  });

  test('input from an old generation is rejected after reattach', () => {
    const { registry, panes } = setup();
    const id = registry.create('https://example.com');
    const first = registry.attach(id, 'controller-a');
    expect(registry.handleInput(id, first, 1, text('a'))).toBe(true);
    registry.detach(id);
    const second = registry.attach(id, 'controller-b');
    expect(second).toBeGreaterThan(first);
    expect(registry.handleInput(id, first, 2, text('old controller'))).toBe(false);
    expect(registry.handleInput(id, second, 1, text('new controller'))).toBe(true);
    expect(panes[0]?.inputs).toHaveLength(2);
  });

  test('input before attach is rejected', () => {
    const { registry } = setup();
    const id = registry.create('https://example.com');
    expect(registry.handleInput(id, 1, 1, text('a'))).toBe(false);
  });

  test('release sends key-up and pointer-up for everything held, once', () => {
    const { registry, panes } = setup();
    const id = registry.create('https://example.com');
    const generation = registry.attach(id, 'controller-a');
    const pane = panes[0];
    if (!pane) throw new Error('No pane');

    registry.handleInput(id, generation, 0, {
      kind: 'key',
      key: 'Shift',
      modifiers: ['shift'],
    });
    registry.handleInput(id, generation, 1, {
      kind: 'pointer',
      action: 'down',
      x: 10,
      y: 20,
      button: 'left',
    });
    // The release follows the pointer, not the press position.
    registry.handleInput(id, generation, 2, { kind: 'pointer', action: 'move', x: 12, y: 22 });

    expect(registry.release(id)).toBe(2);
    expect(pane.inputs.slice(3)).toEqual([
      { kind: 'key', key: 'Shift', modifiers: ['shift'], up: true },
      { kind: 'pointer', action: 'up', x: 12, y: 22, button: 'left' },
    ]);
    // Released input is cleared, so a second loss sends nothing.
    expect(registry.release(id)).toBe(0);
    expect(pane.inputs).toHaveLength(5);
  });

  test('a released key or button is not released twice', () => {
    const { registry, panes } = setup();
    const id = registry.create('https://example.com');
    const generation = registry.attach(id, 'controller-a');
    const pane = panes[0];
    if (!pane) throw new Error('No pane');

    registry.handleInput(id, generation, 0, { kind: 'key', key: 'a' });
    registry.handleInput(id, generation, 1, { kind: 'key', key: 'a', up: true });
    registry.handleInput(id, generation, 2, {
      kind: 'pointer',
      action: 'down',
      x: 1,
      y: 2,
      button: 'right',
    });
    registry.handleInput(id, generation, 3, {
      kind: 'pointer',
      action: 'up',
      x: 1,
      y: 2,
      button: 'right',
    });

    expect(registry.release(id)).toBe(0);
    expect(pane.inputs).toHaveLength(4);
  });

  test('release works while detached and re-releases nothing after reattach', () => {
    const { registry, panes } = setup();
    const id = registry.create('https://example.com');
    const first = registry.attach(id, 'controller-a');
    registry.handleInput(id, first, 0, { kind: 'key', key: 'a' });
    registry.detach(id);
    expect(registry.release(id)).toBe(1);
    const second = registry.attach(id, 'controller-b');
    expect(registry.handleInput(id, second, 0, text('b'))).toBe(true);
    expect(registry.release(id)).toBe(0);
    expect(panes[0]?.inputs.at(-1)).toEqual(text('b'));
  });

  test('stop closes the pane once and forgets the session', () => {
    const { registry, panes } = setup();
    const id = registry.create('https://example.com');
    registry.attach(id, 'controller-a');
    registry.stop(id);
    expect(panes[0]?.closed).toBe(true);
    expect(() => registry.attach(id, 'controller-a')).toThrow();
  });
});
