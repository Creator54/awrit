import { describe, expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { checkboxPrompt, confirmPrompt, selectPrompt, textPrompt } from './prompt';

function createMockStream(isTTY = true) {
  const stream = new PassThrough() as any;
  stream.isTTY = isTTY;
  stream.setRawMode = () => {};
  return stream;
}

describe('checkboxPrompt', () => {
  test('returns preselectedIds if non-TTY', async () => {
    const stdin = createMockStream(false);
    const stdout = createMockStream(false);
    const res = await checkboxPrompt({
      title: 'Choose',
      items: [{ id: 'a', label: 'Item A' }],
      preselectedIds: ['a'],
      stdin,
      stdout,
    });
    expect(res).toEqual(['a']);
  });

  test('cancels on escape', async () => {
    const stdin = createMockStream(true);
    const stdout = createMockStream(true);
    const promise = checkboxPrompt({
      title: 'Choose',
      items: [{ id: 'a', label: 'Item A' }],
      stdin,
      stdout,
    });
    setTimeout(() => {
      stdin.emit('keypress', '\x1b', { name: 'escape', ctrl: false, meta: false });
    }, 10);
    const res = await promise;
    expect(res).toBeNull();
  });

  test('selects item with space and confirms with enter', async () => {
    const stdin = createMockStream(true);
    const stdout = createMockStream(true);
    const promise = checkboxPrompt({
      title: 'Choose',
      items: [{ id: 'a', label: 'Item A' }],
      stdin,
      stdout,
    });
    setTimeout(() => {
      // space to toggle first item
      stdin.emit('keypress', ' ', { name: 'space', ctrl: false, meta: false });
      // return to confirm
      stdin.emit('keypress', '\r', { name: 'return', ctrl: false, meta: false });
    }, 10);
    const res = await promise;
    expect(res).toEqual(['a']);
  });

  test('selects all items with a key toggle', async () => {
    const stdin = createMockStream(true);
    const stdout = createMockStream(true);
    const promise = checkboxPrompt({
      title: 'Choose',
      items: [
        { id: 'a', label: 'Item A' },
        { id: 'b', label: 'Item B' },
      ],
      stdin,
      stdout,
    });
    setTimeout(() => {
      stdin.emit('keypress', 'a', { name: 'a', ctrl: false, meta: false });
      stdin.emit('keypress', '\r', { name: 'return', ctrl: false, meta: false });
    }, 10);
    const res = await promise;
    expect(res).toEqual(['a', 'b']);
  });
});

describe('selectPrompt', () => {
  test('returns defaultId or first item if non-TTY', async () => {
    const stdin = createMockStream(false);
    const stdout = createMockStream(false);
    const res = await selectPrompt({
      title: 'Choose one',
      items: [
        { id: 'a', label: 'Item A' },
        { id: 'b', label: 'Item B' },
      ],
      defaultId: 'b',
      stdin,
      stdout,
    });
    expect(res).toBe('b');
  });

  test('navigates with arrows and confirms with enter', async () => {
    const stdin = createMockStream(true);
    const stdout = createMockStream(true);
    const promise = selectPrompt({
      title: 'Choose one',
      items: [
        { id: 'a', label: 'Item A' },
        { id: 'b', label: 'Item B' },
      ],
      stdin,
      stdout,
    });
    setTimeout(() => {
      stdin.emit('keypress', '', { name: 'down', ctrl: false, meta: false });
      stdin.emit('keypress', '\r', { name: 'return', ctrl: false, meta: false });
    }, 10);
    const res = await promise;
    expect(res).toBe('b');
  });

  test('cancels on escape', async () => {
    const stdin = createMockStream(true);
    const stdout = createMockStream(true);
    const promise = selectPrompt({
      title: 'Choose one',
      items: [{ id: 'a', label: 'Item A' }],
      stdin,
      stdout,
    });
    setTimeout(() => {
      stdin.emit('keypress', '\x1b', { name: 'escape', ctrl: false, meta: false });
    }, 10);
    const res = await promise;
    expect(res).toBeNull();
  });
});

describe('confirmPrompt', () => {
  test('returns default in non-TTY', async () => {
    const stdin = createMockStream(false);
    const stdout = createMockStream(false);
    expect(await confirmPrompt({ title: 'Sure?', defaultYes: true, stdin, stdout })).toBe(true);
    expect(await confirmPrompt({ title: 'Sure?', defaultYes: false, stdin, stdout })).toBe(false);
  });

  test('toggles with y/n keys', async () => {
    const stdin = createMockStream(true);
    const stdout = createMockStream(true);
    const p1 = confirmPrompt({ title: 'Sure?', defaultYes: false, stdin, stdout });
    setTimeout(() => {
      stdin.emit('keypress', 'y', { name: 'y', ctrl: false, meta: false });
    }, 10);
    expect(await p1).toBe(true);

    const p2 = confirmPrompt({ title: 'Sure?', defaultYes: true, stdin, stdout });
    setTimeout(() => {
      stdin.emit('keypress', 'n', { name: 'n', ctrl: false, meta: false });
    }, 10);
    expect(await p2).toBe(false);
  });
});

describe('textPrompt', () => {
  test('returns defaultValue in non-TTY', async () => {
    const stdin = createMockStream(false);
    const stdout = createMockStream(false);
    const res = await textPrompt({ title: 'Enter name', defaultValue: 'pixel', stdin, stdout });
    expect(res).toBe('pixel');
  });

  test('types text and confirms', async () => {
    const stdin = createMockStream(true);
    const stdout = createMockStream(true);
    const promise = textPrompt({ title: 'Enter name', stdin, stdout });
    setTimeout(() => {
      stdin.emit('keypress', 'a', { name: 'a', ctrl: false, meta: false });
      stdin.emit('keypress', 'b', { name: 'b', ctrl: false, meta: false });
      stdin.emit('keypress', '\r', { name: 'return', ctrl: false, meta: false });
    }, 10);
    const res = await promise;
    expect(res).toBe('ab');
  });
});
