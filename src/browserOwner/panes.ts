// Synchronous state transitions serialize final detach against incoming attach.
export class PaneRegistry {
  private panes = new Set<string>();
  private draining = false;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;

  // Staying up for idleMs after the last pane closes lets the next viewer skip browser startup.
  constructor(
    private readonly onShutdown: () => void,
    private readonly idleMs = 0,
  ) {}

  get size(): number {
    return this.panes.size;
  }

  attach(id: string): boolean {
    if (this.draining) return false;
    if (this.panes.has(id)) throw new Error('Duplicate pane identity');
    clearTimeout(this.idleTimer);
    this.panes.add(id);
    return true;
  }

  detach(id: string): void {
    if (!this.panes.delete(id) || this.panes.size || this.draining) return;
    if (this.idleMs) this.idleTimer = setTimeout(() => this.shutdown(), this.idleMs);
    else this.shutdown();
  }

  shutdown(): void {
    if (this.draining) return;
    this.draining = true;
    clearTimeout(this.idleTimer);
    this.onShutdown();
  }
}
