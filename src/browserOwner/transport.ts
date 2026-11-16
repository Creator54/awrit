import { encodeFrame, type FrameKind } from './protocol';

interface OutputSocket {
  readonly writableLength: number;
  readonly destroyed: boolean;
  write(frame: Buffer): boolean;
  destroy(): void;
  on(event: 'drain' | 'close', callback: () => void): unknown;
}

const maxQueued = 1024 * 1024;
const outputChunk = 256 * 1024;

/** A per-connection queue. A false return requires the producer to pause. */
export class TerminalWriter {
  private queue: Buffer[] = [];
  private queuedBytes = 0;
  private blocked = false;
  private closed = false;
  private drainListeners = new Set<() => void>();

  constructor(private socket: OutputSocket) {
    socket.on('drain', () => {
      if (this.closed) return;
      this.blocked = false;
      this.flush();
      if (!this.blocked && !this.queue.length) {
        for (const listener of this.drainListeners) listener();
      }
    });
    socket.on('close', () => this.close());
  }

  onDrain(listener: () => void): () => void {
    this.drainListeners.add(listener);
    return () => this.drainListeners.delete(listener);
  }

  writeOutput(bytes: Uint8Array): boolean {
    if (this.closed || this.socket.destroyed) return false;
    // Count framing overhead before allocating copies of untrusted-size output.
    const overhead = Math.ceil(bytes.byteLength / outputChunk) * 5;
    if (!this.reserve(bytes.byteLength + overhead)) return false;
    for (let offset = 0; offset < bytes.byteLength; offset += outputChunk) {
      this.enqueue(encodeFrame('output', bytes.subarray(offset, offset + outputChunk)));
    }
    this.flush();
    return !this.closed && !this.blocked;
  }

  writeControl(bytes: Uint8Array): boolean {
    return this.writeFrame('control', bytes);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.queuedBytes = 0;
    this.drainListeners.clear();
    this.socket.destroy();
  }

  private reserve(count: number): boolean {
    if (count + this.queuedBytes + this.socket.writableLength > maxQueued) {
      this.close();
      return false;
    }
    return true;
  }

  private writeFrame(kind: FrameKind, bytes: Uint8Array): boolean {
    if (this.closed || this.socket.destroyed) return false;
    const frame = encodeFrame(kind, bytes);
    if (!this.reserve(frame.length)) return false;
    this.enqueue(frame);
    this.flush();
    return !this.closed && !this.blocked;
  }

  private enqueue(frame: Buffer): void {
    this.queue.push(frame);
    this.queuedBytes += frame.length;
  }

  private flush(): void {
    while (!this.blocked && !this.closed && this.queue.length) {
      const frame = this.queue.shift();
      if (!frame) return;
      this.queuedBytes -= frame.length;
      this.blocked = !this.socket.write(frame);
    }
  }
}
