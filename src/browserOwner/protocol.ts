export type FrameKind = 'control' | 'output';
export interface Frame {
  kind: FrameKind;
  payload: Buffer;
}

// Control frames carry tool results too: `text` (15k chars) and `snapshot` (1000 nodes)
// can pass 64 KiB once JSON-escaped, so the cap matches the output frame.
const limits: Record<FrameKind, number> = { control: 256 * 1024, output: 256 * 1024 };
const kindIds: Record<FrameKind, number> = { control: 1, output: 2 };

export function encodeFrame(kind: FrameKind, payload: Uint8Array): Buffer {
  if (payload.byteLength > limits[kind]) throw new Error(`Oversized ${kind} frame`);
  const frame = Buffer.allocUnsafe(5 + payload.byteLength);
  frame.writeUInt32BE(payload.byteLength + 1);
  frame[4] = kindIds[kind];
  frame.set(payload, 5);
  return frame;
}

/** Only one bounded partial frame is retained between socket reads. */
export class FrameDecoder {
  private header = Buffer.alloc(5);
  private headerBytes = 0;
  private payload: Buffer | undefined;
  private payloadBytes = 0;
  private kind: FrameKind = 'control';

  push(chunk: Uint8Array): Frame[] {
    const frames: Frame[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.headerBytes < 5) {
        const count = Math.min(5 - this.headerBytes, chunk.byteLength - offset);
        this.header.set(chunk.subarray(offset, offset + count), this.headerBytes);
        this.headerBytes += count;
        offset += count;
        if (this.headerBytes >= 4 && this.header.readUInt32BE() === 0) {
          throw new Error('Empty terminal frame');
        }
        if (this.headerBytes < 5) continue;
        const id = this.header[4];
        if (id !== 1 && id !== 2) throw new Error('Unknown terminal frame kind');
        this.kind = id === 1 ? 'control' : 'output';
        const length = this.header.readUInt32BE() - 1;
        if (length > limits[this.kind]) throw new Error(`Oversized ${this.kind} frame`);
        this.payload = Buffer.allocUnsafe(length);
      }
      const payload = this.payload;
      if (!payload) throw new Error('Missing terminal frame payload');
      const count = Math.min(payload.length - this.payloadBytes, chunk.byteLength - offset);
      payload.set(chunk.subarray(offset, offset + count), this.payloadBytes);
      this.payloadBytes += count;
      offset += count;
      if (this.payloadBytes === payload.length) {
        frames.push({ kind: this.kind, payload });
        this.headerBytes = 0;
        this.payload = undefined;
        this.payloadBytes = 0;
      }
    }
    return frames;
  }
}
