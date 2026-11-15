import { describe, expect, test } from 'bun:test';
import { waitForContentPaint } from './paintReadiness';

type Listener = () => void;

class FakeContents {
  destroyed = false;
  invalidations = 0;
  private listeners = new Map<string, Listener[]>();

  once(event: string, listener: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  removeListener(event: string, listener: Listener) {
    this.listeners.set(event, (this.listeners.get(event) ?? []).filter((item) => item !== listener));
    return this;
  }

  isDestroyed() {
    return this.destroyed;
  }

  invalidate() {
    this.invalidations++;
  }

  emit(event: string) {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.set(event, []);
    for (const listener of listeners) listener();
  }
}

const target = () => new FakeContents() as unknown as Parameters<typeof waitForContentPaint>[0] & FakeContents;

describe('paint readiness', () => {
  test('resolves only after the target paints, and invalidates it first', async () => {
    const contents = target();
    const ready = waitForContentPaint(contents);
    expect(contents.invalidations).toBe(1);
    contents.emit('paint');
    await expect(ready).resolves.toBeUndefined();
    contents.emit('paint');
  });

  test('rejects when the target is destroyed before painting', async () => {
    const contents = target();
    const ready = waitForContentPaint(contents);
    contents.destroyed = true;
    contents.emit('destroyed');
    await expect(ready).rejects.toThrow('Page closed before it painted');
  });

  test('rejects instead of pretending a silent target is ready', async () => {
    const contents = target();
    await expect(waitForContentPaint(contents, 10)).rejects.toThrow('Page did not paint in time');
  });
});
