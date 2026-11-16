import { EventEmitter } from 'node:events';
import { expect, test } from 'bun:test';
import { DebuggerManager } from './debugger';

class FakeDebugger extends EventEmitter {
  attached = false;
  attachCalls = 0;
  detachCalls = 0;
  commands: string[] = [];

  isAttached() {
    return this.attached;
  }

  attach() {
    this.attachCalls++;
    if (this.attached) throw new Error('already attached');
    this.attached = true;
  }

  detach() {
    this.detachCalls++;
    this.attached = false;
    this.emit('detach', {}, 'target_closed');
  }

  async sendCommand(method: string) {
    if (!this.attached) throw new Error('not attached');
    this.commands.push(method);
    return {};
  }
}

function createTarget(debuggerApi = new FakeDebugger()) {
  const webContents = Object.assign(new EventEmitter(), {
    debugger: debuggerApi,
    isDestroyed: () => false,
  }) as unknown as Electron.WebContents;
  return { webContents, debuggerApi };
}

test('keeps one attachment until every concurrent lease is released', async () => {
  const manager = new DebuggerManager();
  const { webContents, debuggerApi } = createTarget();
  const first = manager.acquire(webContents);
  const second = manager.acquire(webContents);

  expect(debuggerApi.attachCalls).toBe(1);
  first.release();
  expect(debuggerApi.detachCalls).toBe(0);
  await second.sendCommand('Page.enable');
  second.release();

  expect(debuggerApi.detachCalls).toBe(1);
});

test('never detaches a debugger attached before Awrit acquired a lease', () => {
  const manager = new DebuggerManager();
  const debuggerApi = new FakeDebugger();
  debuggerApi.attached = true;
  const { webContents } = createTarget(debuggerApi);

  const lease = manager.acquire(webContents);
  lease.release();

  expect(debuggerApi.attachCalls).toBe(0);
  expect(debuggerApi.detachCalls).toBe(0);
});

test('can reacquire after release and after external detach', async () => {
  const manager = new DebuggerManager();
  const { webContents, debuggerApi } = createTarget();
  const first = manager.acquire(webContents);
  first.release();
  const second = manager.acquire(webContents);
  await second.sendCommand('Page.enable');
  second.release();

  const third = manager.acquire(webContents);
  debuggerApi.emit('detach', {}, 'devtools');
  const fourth = manager.acquire(webContents);
  await fourth.sendCommand('Page.enable');
  fourth.release();
  third.release();

  expect(debuggerApi.attachCalls).toBe(3);
});

test('routes debugger messages to active lease listeners and removes them on release', () => {
  const manager = new DebuggerManager();
  const { webContents, debuggerApi } = createTarget();
  const lease = manager.acquire(webContents);
  const seen: unknown[] = [];
  const unsubscribe = lease.onMessage('Input.dragIntercepted', (_params) => seen.push(_params));

  debuggerApi.emit('message', {}, 'Input.dragIntercepted', { data: 'payload' }, '');
  expect(seen).toEqual([{ data: 'payload' }]);
  unsubscribe();
  debuggerApi.emit('message', {}, 'Input.dragIntercepted', { data: 'ignored' }, '');
  expect(seen).toEqual([{ data: 'payload' }]);
  const released = manager.acquire(webContents);
  const releasedSeen: unknown[] = [];
  released.onMessage('Input.dragIntercepted', (params) => releasedSeen.push(params));
  released.release();
  debuggerApi.emit('message', {}, 'Input.dragIntercepted', { data: 'after-release' }, '');
  expect(releasedSeen).toEqual([]);
  lease.release();

  expect(debuggerApi.listenerCount('message')).toBe(0);
});

test('invalidates leases on external detach and target destruction', async () => {
  for (const endTarget of [
    (target: ReturnType<typeof createTarget>) => target.debuggerApi.emit('detach', {}, 'replaced_with_devtools'),
    (target: ReturnType<typeof createTarget>) => (target.webContents as unknown as EventEmitter).emit('destroyed'),
  ]) {
    const manager = new DebuggerManager();
    const target = createTarget();
    const lease = manager.acquire(target.webContents);
    const subscribe = lease.onMessage('Input.dragIntercepted', () => {});
    endTarget(target);

    expect(target.debuggerApi.listenerCount('message')).toBe(0);
    const lateSubscription = lease.onMessage('Input.dragIntercepted', () => {});
    lateSubscription();
    subscribe();
    expect(target.debuggerApi.listenerCount('detach')).toBe(0);
    expect((target.webContents as unknown as EventEmitter).listenerCount('destroyed')).toBe(0);
    await expect(lease.sendCommand('Page.enable')).rejects.toThrow();
    lease.release();
    expect(target.debuggerApi.detachCalls).toBe(0);
  }
});
