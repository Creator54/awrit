type DebuggerMessageListener = (params: Record<string, unknown>) => void;

export interface DebuggerLease {
  sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
  onMessage(method: string, listener: DebuggerMessageListener): () => void;
  release(): void;
}

interface Entry {
  webContents: Electron.WebContents;
  debugger: Electron.Debugger;
  ownsAttachment: boolean;
  leases: Set<Lease>;
  messageListeners: Map<string, Set<DebuggerMessageListener>>;
  onMessage: (event: Electron.Event, method: string, params: Record<string, unknown>) => void;
  onDetach: () => void;
  onDestroyed: () => void;
  valid: boolean;
}

class Lease implements DebuggerLease {
  private released = false;
  private readonly subscriptions = new Set<() => void>();

  constructor(
    private readonly manager: DebuggerManager,
    private readonly entry: Entry,
  ) {}

  async sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown> {
    if (!this.manager.isLeaseActive(this, this.entry)) {
      throw new Error('Debugger lease is no longer active');
    }
    return this.entry.debugger.sendCommand(method, params);
  }

  onMessage(method: string, listener: DebuggerMessageListener): () => void {
    if (!this.manager.isLeaseActive(this, this.entry)) {
      return () => {};
    }
    let listeners = this.entry.messageListeners.get(method);
    if (!listeners) {
      listeners = new Set();
      this.entry.messageListeners.set(method, listeners);
    }
    listeners.add(listener);
    const unsubscribe = () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) this.entry.messageListeners.delete(method);
      this.subscriptions.delete(unsubscribe);
    };
    this.subscriptions.add(unsubscribe);
    return unsubscribe;
  }

  invalidate(): void {
    this.released = true;
    for (const unsubscribe of this.subscriptions) unsubscribe();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    for (const unsubscribe of this.subscriptions) unsubscribe();
    this.manager.release(this, this.entry);
  }
}

export class DebuggerManager {
  private readonly entries = new WeakMap<Electron.WebContents, Entry>();

  acquire(webContents: Electron.WebContents): DebuggerLease {
    if (webContents.isDestroyed()) throw new Error('Cannot attach debugger to destroyed webContents');

    let entry = this.entries.get(webContents);
    if (!entry) {
      const debuggerApi = webContents.debugger;
      const ownsAttachment = !debuggerApi.isAttached();
      if (ownsAttachment) debuggerApi.attach('1.3');

      const created: Entry = {
        webContents,
        debugger: debuggerApi,
        ownsAttachment,
        leases: new Set(),
        messageListeners: new Map(),
        onMessage: (_event, method, params) => {
          for (const listener of created.messageListeners.get(method) ?? []) {
            try {
              listener(params ?? {});
            } catch (error) {
              console.error('Debugger message listener failed:', error);
            }
          }
        },
        onDetach: () => this.invalidate(created),
        onDestroyed: () => this.invalidate(created),
        valid: true,
      };
      debuggerApi.on('message', created.onMessage);
      debuggerApi.on('detach', created.onDetach);
      webContents.once('destroyed', created.onDestroyed);
      this.entries.set(webContents, created);
      entry = created;
    }

    const lease = new Lease(this, entry);
    entry.leases.add(lease);
    return lease;
  }

  isLeaseActive(lease: Lease, entry: Entry): boolean {
    return entry.valid && entry.leases.has(lease);
  }

  release(lease: Lease, entry: Entry): void {
    if (!entry.valid || !entry.leases.delete(lease) || entry.leases.size > 0) return;
    entry.valid = false;
    this.cleanup(entry);
    if (entry.ownsAttachment && !entry.webContents.isDestroyed() && entry.debugger.isAttached()) {
      try {
        entry.debugger.detach();
      } catch {
        // The target may have detached between the state check and detach.
      }
    }
  }

  private invalidate(entry: Entry): void {
    if (!entry.valid) return;
    entry.valid = false;
    for (const lease of entry.leases) lease.invalidate();
    entry.leases.clear();
    this.cleanup(entry);
  }

  private cleanup(entry: Entry): void {
    entry.debugger.off('message', entry.onMessage);
    entry.debugger.off('detach', entry.onDetach);
    if (!entry.webContents.isDestroyed()) entry.webContents.off('destroyed', entry.onDestroyed);
    this.entries.delete(entry.webContents);
    entry.messageListeners.clear();
  }
}

export const debuggerManager = new DebuggerManager();
