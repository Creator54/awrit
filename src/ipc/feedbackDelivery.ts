export interface FeedbackSocket {
  destroyed: boolean;
  write(data: string, callback?: (error?: Error | null) => void): boolean;
}

export type FeedbackPayload = {
  draftId: string;
  [key: string]: unknown;
};

export type DeliveryResult =
  | { ok: true }
  | { ok: false; error: string };

interface PendingEntry {
  promise: Promise<DeliveryResult>;
  resolve: (result: DeliveryResult) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class FeedbackDeliveryTracker {
  private readonly timeoutMs: number;
  private readonly maxPending: number;
  private pendingCount = 0;
  private readonly sockets = new Map<FeedbackSocket, Map<string, PendingEntry>>();

  constructor(timeoutMs = 3000, maxPending = 128) {
    this.timeoutMs = timeoutMs;
    this.maxPending = maxPending;
  }

  getPendingCount(): number {
    return this.pendingCount;
  }

  hasPending(socket: FeedbackSocket, draftId: string): boolean {
    return this.sockets.get(socket)?.has(draftId) ?? false;
  }

  send(socket: FeedbackSocket, payload: FeedbackPayload): Promise<DeliveryResult> {
    if (!payload || typeof payload.draftId !== 'string' || payload.draftId.length === 0) {
      return Promise.resolve({ ok: false, error: 'Invalid draftId' });
    }

    const { draftId } = payload;

    // 1. In-flight duplicate outstanding request returns existing promise (no duplicate write)
    const socketMap = this.sockets.get(socket);
    const existing = socketMap?.get(draftId);
    if (existing) {
      return existing.promise;
    }

    // 2. Global pending capacity check
    if (this.pendingCount >= this.maxPending) {
      return Promise.resolve({ ok: false, error: 'Pending feedback cap exceeded' });
    }

    if (socket.destroyed) {
      return Promise.resolve({ ok: false, error: 'Socket is destroyed' });
    }

    // 3. Register pending before write
    let resolver!: (result: DeliveryResult) => void;
    const promise = new Promise<DeliveryResult>((resolve) => {
      resolver = resolve;
    });

    const timer = setTimeout(() => {
      if (this.sockets.get(socket)?.get(draftId) !== entry) return;
      this.settle(socket, draftId, {
        ok: false,
        error: 'Feedback acceptance not confirmed; outcome unknown',
      });
    }, this.timeoutMs);

    const entry: PendingEntry = {
      promise,
      resolve: resolver,
      timer,
    };

    let drafts = socketMap;
    if (!drafts) {
      drafts = new Map<string, PendingEntry>();
      this.sockets.set(socket, drafts);
    }
    drafts.set(draftId, entry);
    this.pendingCount++;

    // 4. Write event design:send-feedback
    try {
      const message = JSON.stringify({ ...payload, event: 'design:send-feedback' }) + '\n';
      socket.write(message, (err) => {
        if (this.sockets.get(socket)?.get(draftId) !== entry) return;
        if (err) {
          this.settle(socket, draftId, {
            ok: false,
            error: err.message || 'Write failed',
          });
        }
      });
    } catch (err) {
      this.settle(socket, draftId, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return promise;
  }

  ack(socket: FeedbackSocket, draftId: string, ok: boolean, error?: string): boolean {
    const entry = this.sockets.get(socket)?.get(draftId);
    if (!entry) {
      return false;
    }

    if (ok) {
      this.settle(socket, draftId, { ok: true });
    } else {
      this.settle(socket, draftId, {
        ok: false,
        error: error ?? 'Feedback rejected',
      });
    }
    return true;
  }

  disconnect(socket: FeedbackSocket): number {
    const drafts = this.sockets.get(socket);
    if (!drafts || drafts.size === 0) {
      return 0;
    }

    const entries = Array.from(drafts.entries());
    for (const [draftId] of entries) {
      this.settle(socket, draftId, {
        ok: false,
        error: 'Feedback acceptance not confirmed; outcome unknown',
      });
    }
    return entries.length;
  }

  dispose(): void {
    for (const [socket, drafts] of Array.from(this.sockets.entries())) {
      for (const [draftId] of Array.from(drafts.entries())) {
        this.settle(socket, draftId, {
          ok: false,
          error: 'Feedback acceptance not confirmed; outcome unknown',
        });
      }
    }
    this.sockets.clear();
    this.pendingCount = 0;
  }

  private settle(socket: FeedbackSocket, draftId: string, result: DeliveryResult): void {
    const drafts = this.sockets.get(socket);
    if (!drafts) {
      return;
    }
    const entry = drafts.get(draftId);
    if (!entry) {
      return;
    }

    clearTimeout(entry.timer);
    drafts.delete(draftId);
    this.pendingCount = Math.max(0, this.pendingCount - 1);
    if (drafts.size === 0) {
      this.sockets.delete(socket);
    }

    entry.resolve(result);
  }
}
