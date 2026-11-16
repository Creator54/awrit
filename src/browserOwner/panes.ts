// Synchronous state transitions serialize final detach against incoming attach.
export class PaneRegistry {
  private panes = new Set<string>();
  private draining = false;

  constructor(private readonly onShutdown: () => void) {}

  attach(id: string): boolean {
    if (this.draining) return false;
    if (this.panes.has(id)) throw new Error('Duplicate pane identity');
    this.panes.add(id);
    return true;
  }

  detach(id: string): void {
    if (!this.panes.delete(id)) return;
    if (!this.panes.size) this.shutdown();
  }

  shutdown(): void {
    if (this.draining) return;
    this.draining = true;
    this.onShutdown();
  }
}
