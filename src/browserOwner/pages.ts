/** Page selection belongs to one PTY, never the process-wide focused view. */
export class PanePages<T> {
  private readonly pages: T[] = [];
  current: T | undefined;

  add(page: T): void {
    this.pages.push(page);
    this.current = page;
  }

  all(): T[] {
    return [...this.pages];
  }

  cycle(step = 1): T | undefined {
    if (this.pages.length < 2) return undefined;
    const index = this.current === undefined ? -1 : this.pages.indexOf(this.current);
    const count = this.pages.length;
    this.current = this.pages[(((index + step) % count) + count) % count];
    return this.current;
  }

  /** Zero-based; returns undefined when that tab does not exist or is already shown. */
  select(index: number): T | undefined {
    const page = this.pages[index];
    if (page === undefined || page === this.current) return undefined;
    this.current = page;
    return page;
  }

  /** Removes the current page and shows its neighbour. Returns both, or undefined if none is current. */
  closeCurrent(): { closed: T; next: T | undefined } | undefined {
    const closed = this.current;
    if (closed === undefined) return undefined;
    const index = this.pages.indexOf(closed);
    this.pages.splice(index, 1);
    this.current = this.pages[Math.min(index, this.pages.length - 1)];
    return { closed, next: this.current };
  }

  /** Removes page at zero-based index. Returns the removed page and the new current, or undefined if out of bounds. */
  closeAt(index: number): { closed: T; next: T | undefined } | undefined {
    const closed = this.pages[index];
    if (closed === undefined) return undefined;
    this.pages.splice(index, 1);
    if (this.current === closed) {
      this.current = this.pages[Math.min(index, this.pages.length - 1)];
    }
    return { closed, next: this.current };
  }

  clear(): T[] {
    const removed = this.pages.splice(0);
    this.current = undefined;
    return removed;
  }
}
