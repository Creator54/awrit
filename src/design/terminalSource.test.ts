import { describe, expect, test } from 'bun:test';
import { formatNotes } from './notes';
import { validateFrozenSource } from './validation';

const bounds = { x: 0, y: 0, width: 80, height: 30 };
const note = { id: 'a', comment: 'Fix the prompt', selection: { kind: 'region' as const, bounds } };

describe('terminal FrozenSource validation', () => {
  test('accepts a strict positive Kitty window id with optional bounded title', () => {
    expect(validateFrozenSource({ kind: 'terminal', windowId: '42', title: 'build' })).toEqual({
      kind: 'terminal',
      windowId: '42',
      title: 'build',
    });
    expect(validateFrozenSource({ kind: 'terminal', windowId: '1' })).toEqual({
      kind: 'terminal',
      windowId: '1',
    });
  });

  test('accepts a TUIOS pane id and names it as a pane', () => {
    const windowId = '6e5790e5-e9c0-465c-b039-357f87fb1e79';
    expect(validateFrozenSource({ kind: 'terminal', windowId })).toEqual({ kind: 'terminal', windowId });
    expect(formatNotes([note], { kind: 'terminal', windowId })).toContain(`TUIOS pane ${windowId}`);
  });

  test('rejects non-numeric, signed, zero, padded and non-string window ids', () => {
    for (const windowId of ['', '0', '-1', '+1', '1.5', 'abc', ' 42', '42 ', '042', '1e3', '0x2a']) {
      expect(() => validateFrozenSource({ kind: 'terminal', windowId })).toThrow();
    }
    for (const windowId of [42, null, undefined, {}]) {
      expect(() => validateFrozenSource({ kind: 'terminal', windowId })).toThrow();
    }
    expect(() => validateFrozenSource({ kind: 'terminal' })).toThrow();
  });

  test('rejects overlong window ids and titles, and unknown fields', () => {
    expect(() => validateFrozenSource({ kind: 'terminal', windowId: '1'.repeat(40) })).toThrow();
    expect(() => validateFrozenSource({ kind: 'terminal', windowId: '7', title: 'x'.repeat(2049) })).toThrow();
    expect(() => validateFrozenSource({ kind: 'terminal', windowId: '7', title: 9 })).toThrow();
    expect(() => validateFrozenSource({ kind: 'terminal', windowId: '7', url: 'https://example.com' })).toThrow();
  });
});

describe('terminal note output', () => {
  test('describes the Kitty window honestly, without a web URL', () => {
    const out = formatNotes([note], { kind: 'terminal', windowId: '42', title: 'build logs' });
    expect(out).toContain('Kitty window 42');
    expect(out).toContain('build logs');
    expect(out).toContain('Fix the prompt');
    expect(out).not.toContain('http://');
    expect(out).not.toContain('https://');
  });

  test('omits the title when absent and keeps annotation-free output stable', () => {
    const out = formatNotes([note], { kind: 'terminal', windowId: '42' });
    expect(out).toContain('Kitty window 42');
    expect(out).not.toContain('()');
    expect(formatNotes([note])).toBe('• #1 Box 80×30: Fix the prompt');
  });
});
