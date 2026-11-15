export class RendererRouter<T> {
  private handlers = new Map<number, T>();

  add(sender: number, handler: T): void {
    if (this.handlers.has(sender)) throw new Error('Renderer already registered');
    this.handlers.set(sender, handler);
  }

  get(sender: number): T {
    const handler = this.handlers.get(sender);
    if (!handler) throw new Error('Unknown renderer');
    return handler;
  }

  remove(sender: number): void {
    this.handlers.delete(sender);
  }
}
