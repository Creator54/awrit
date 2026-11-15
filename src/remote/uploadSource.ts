import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_ARTIFACT_BYTES, validateArtifactName } from './artifacts';

export const MAX_UPLOAD_BYTES = MAX_ARTIFACT_BYTES;
const CHUNK_BYTES = 64 * 1024;

export interface ChosenUpload {
  readonly metadata: Readonly<{ name: string; size: number; sha256: string }>;
  /** Single use. The receiver must verify size/hash before exposing these bytes. */
  chunks(): AsyncIterable<Uint8Array>;
  /** Caller must close in finally, including cancellation before chunks() is consumed. */
  close(): Promise<void>;
}

/** Call only with a path explicitly chosen by the local user, never remote input.
 * Parent directory traversal follows normal local filesystem semantics; O_NOFOLLOW
 * protects the final component, not a path inside an attacker-controlled directory.
 */
export async function openChosenUpload(file: string): Promise<ChosenUpload> {
  const name = validateArtifactName(path.basename(file));
  // O_NONBLOCK avoids hanging on a FIFO; fstat rejects it. O_NOFOLLOW rejects a final symlink.
  const handle = await fs.open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  let closed = false;
  let consumed = false;
  async function close() {
    if (closed) return;
    closed = true;
    await handle.close();
  }
  try {
    const initial = await handle.stat({ bigint: true });
    if (!initial.isFile()) throw new Error('Upload must be a regular file');
    if (initial.size > BigInt(MAX_UPLOAD_BYTES)) throw new Error('Upload is too large');
    const size = Number(initial.size);
    async function unchanged() {
      const current = await handle.stat({ bigint: true });
      if (
        current.size !== initial.size ||
        current.mtimeNs !== initial.mtimeNs ||
        current.ctimeNs !== initial.ctimeNs
      ) {
        throw new Error('Chosen upload changed');
      }
    }
    async function* bytes(): AsyncGenerator<Buffer> {
      let offset = 0;
      while (offset < size) {
        if (closed) throw new Error('Upload is closed');
        const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, size - offset));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, offset);
        if (bytesRead === 0) throw new Error('Chosen upload changed');
        offset += bytesRead;
        yield chunk.subarray(0, bytesRead);
      }
    }
    const hash = createHash('sha256');
    for await (const chunk of bytes()) hash.update(chunk);
    await unchanged();
    const sha256 = hash.digest('hex');
    return {
      metadata: Object.freeze({ name, size, sha256 }),
      close,
      async *chunks() {
        if (consumed) throw new Error('Upload already consumed');
        if (closed) throw new Error('Upload is closed');
        consumed = true;
        try {
          await unchanged();
          const sent = createHash('sha256');
          for await (const chunk of bytes()) {
            sent.update(chunk);
            yield chunk;
          }
          await unchanged();
          if (sent.digest('hex') !== sha256) throw new Error('Chosen upload changed');
        } finally {
          await close();
        }
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Calls `touch` before each chunk so an idle deadline restarts while bytes keep flowing. */
export async function* touching<T>(chunks: AsyncIterable<T>, touch: () => void): AsyncGenerator<T> {
  for await (const chunk of chunks) {
    touch();
    yield chunk;
  }
}
