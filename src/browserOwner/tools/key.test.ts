import { describe, expect, test } from 'bun:test';
import { performKey } from './key';

describe('performKey', () => {
  test('rejects empty key', async () => {
    const wc: any = {};
    const res = await performKey(wc, { key: '' });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('Key is required');
  });

  test('rejects null options or non-array modifiers', async () => {
    const wc: any = {};
    // @ts-expect-error null options
    const res1 = await performKey(wc, null);
    expect(res1.ok).toBe(false);
    // @ts-expect-error non-array modifiers
    const res2 = await performKey(wc, { key: 'a', modifiers: 'control' });
    expect(res2.ok).toBe(false);
    expect(res2.error).toBe('Modifiers must be an array');
  });

  test('surfaces sendInputEvent failure', async () => {
    const wc: any = {
      sendInputEvent: () => {
        throw new Error('webContents destroyed');
      },
      executeJavaScript: async () => ({ url: 'about:blank', title: 'test', focusedSelector: null, scroll: { x: 0, y: 0 } }),
    };

    const res = await performKey(wc, { key: 'a' });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Key press failed');
  });

  test('moves the agent cursor to the focused element before pressing', async () => {
    const order: string[] = [];
    const wc: any = {
      sendInputEvent: () => order.push('key'),
      executeJavaScript: async (code: string) => {
        if (code.includes('activeElement') && code.includes('getBoundingClientRect')) return { x: 40, y: 50 };
        if (code.includes('data-awrit') || code.includes('cursor')) order.push('cursor');
        return { url: 'about:blank', title: 't', focusedSelector: null, scroll: { x: 0, y: 0 } };
      },
    };
    const res = await performKey(wc, { key: 'a', previewMs: 1 });
    expect(res.ok).toBe(true);
    expect(order.indexOf('cursor')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('cursor')).toBeLessThan(order.indexOf('key'));
  });

  test('rejects invalid modifier', async () => {
    const wc: any = {};
    // @ts-expect-error invalid mod
    const res = await performKey(wc, { key: 'a', modifiers: ['super'] });
    expect(res.ok).toBe(false);
    expect(res.error).toContain('Invalid modifier');
  });

  test('sends keyDown, char and keyUp for single printable key', async () => {
    const events: any[] = [];
    const wc: any = {
      sendInputEvent: (evt: any) => events.push(evt),
      executeJavaScript: async () => ({ url: 'about:blank', title: 'test', focusedSelector: null, scroll: { x: 0, y: 0 } }),
    };

    const res = await performKey(wc, { key: 'r' });
    expect(res.ok).toBe(true);
    expect(events.length).toBe(3);
    expect(events[0].type).toBe('keyDown');
    expect(events[0].keyCode).toBe('r');
    expect(events[1].type).toBe('char');
    expect(events[1].keyCode).toBe('r');
    expect(events[2].type).toBe('keyUp');
    expect(events[2].keyCode).toBe('r');
  });

  test('sends keyDown and keyUp without char for non-printable or modified key', async () => {
    const events: any[] = [];
    const wc: any = {
      sendInputEvent: (evt: any) => events.push(evt),
      executeJavaScript: async () => ({ url: 'about:blank', title: 'test', focusedSelector: null, scroll: { x: 0, y: 0 } }),
    };

    const res = await performKey(wc, { key: 'Escape' });
    expect(res.ok).toBe(true);
    expect(events.length).toBe(2);
    expect(events[0].type).toBe('keyDown');
    expect(events[0].keyCode).toBe('Escape');
    expect(events[1].type).toBe('keyUp');
    expect(events[1].keyCode).toBe('Escape');
  });

  test('sends Enter as a carriage-return char so forms submit', async () => {
    const events: any[] = [];
    const wc: any = {
      sendInputEvent: (evt: any) => events.push(evt),
      executeJavaScript: async () => ({ url: 'about:blank', title: 'test', focusedSelector: null, scroll: { x: 0, y: 0 } }),
    };

    const res = await performKey(wc, { key: 'Enter' });
    expect(res.ok).toBe(true);
    expect(events.map(evt => [evt.type, evt.keyCode])).toEqual([
      ['keyDown', 'Enter'],
      ['char', '\r'],
      ['keyUp', 'Enter'],
    ]);
  });

  test('passes valid modifiers through to input events', async () => {
    const events: any[] = [];
    const wc: any = {
      sendInputEvent: (evt: any) => events.push(evt),
      executeJavaScript: async () => ({ url: 'about:blank', title: 'test', focusedSelector: null, scroll: { x: 0, y: 0 } }),
    };

    const res = await performKey(wc, { key: 'o', modifiers: ['control'] });
    expect(res.ok).toBe(true);
    expect(events.length).toBe(2); // no char event because of control
    expect(events[0].modifiers).toEqual(['control']);
    expect(events[1].modifiers).toEqual(['control']);
  });
});

describe('performKey keys', () => {
  test('presses a list of keys in order', async () => {
    const events: any[] = [];
    const wc: any = {
      sendInputEvent: (evt: any) => events.push(evt),
      executeJavaScript: async () => ({ url: 'about:blank', title: 'test', focusedSelector: null, scroll: { x: 0, y: 0 } }),
    };
    expect((await performKey(wc, { keys: ['x', 'Enter', 'F3'] })).ok).toBe(true);
    expect(events.filter(e => e.type === 'keyDown').map(e => e.keyCode)).toEqual(['x', 'Enter', 'F3']);
  });

  test('rejects key with keys, empty lists and long lists', async () => {
    const wc: any = {};
    expect((await performKey(wc, { key: 'a', keys: ['b'] })).error).toBe('Use key or keys, not both');
    expect((await performKey(wc, { keys: [] })).error).toBe('Key is required');
    expect((await performKey(wc, { keys: Array(41).fill('a') })).error).toContain('At most 40');
  });
});
