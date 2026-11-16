import { EventEmitter } from 'node:events';
import { expect, test } from 'bun:test';
import { setupDragAndDrop } from './dragAndDropSetup';

class FakeDebugger extends EventEmitter {
  attached = false;
  commands: Array<{ method: string; params: unknown }> = [];

  isAttached() {
    return this.attached;
  }

  attach() {
    this.attached = true;
  }

  detach() {
    this.attached = false;
    this.emit('detach', {}, 'target_closed');
  }

  async sendCommand(method: string, params: unknown) {
    if (!this.attached) throw new Error('not attached');
    this.commands.push({ method, params });
    return {};
  }
}

test('drag setup owns one lease, dispatches intercepted drags, and releases cleanly', async () => {
  const debuggerApi = new FakeDebugger();
  const webContents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    isDestroyed: () => false,
    getZoomFactor: () => 2,
    lastMousePos: { x: 20, y: 40, modifiers: 1 },
  }) as unknown as Electron.WebContents;

  const stop = setupDragAndDrop(webContents);
  await Promise.resolve();
  expect(debuggerApi.commands[0]).toEqual({
    method: 'Input.setInterceptDrags',
    params: { enabled: true },
  });

  debuggerApi.emit('message', {}, 'Input.dragIntercepted', { data: 'drag-data' }, '');
  await Promise.resolve();
  expect(debuggerApi.commands[1]).toEqual({
    method: 'Input.dispatchDragEvent',
    params: {
      type: 'dragEnter',
      x: 10,
      y: 20,
      data: 'drag-data',
      modifiers: 1,
    },
  });

  stop();
  stop();
  expect(debuggerApi.isAttached()).toBe(false);
  expect(debuggerApi.listenerCount('message')).toBe(0);
});

test('external detach invalidates drag interception until setup is recreated', async () => {
  const debuggerApi = new FakeDebugger();
  const webContents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    isDestroyed: () => false,
    getZoomFactor: () => 1,
    lastMousePos: { x: 50, y: 50, modifiers: 0 },
  }) as unknown as Electron.WebContents;

  const stop = setupDragAndDrop(webContents);
  await Promise.resolve();
  expect(debuggerApi.commands).toHaveLength(1);

  debuggerApi.detach();
  expect(debuggerApi.listenerCount('message')).toBe(0);
  debuggerApi.emit('message', {}, 'Input.dragIntercepted', { data: 'stale-drag' }, '');
  await Promise.resolve();

  // External detach is a deliberate graceful-degradation boundary; no attach loop.
  expect(debuggerApi.commands).toHaveLength(1);
  expect(() => stop()).not.toThrow();
});
