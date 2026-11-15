import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export interface ArtifactOffer {
  id: string;
  name: string;
  mime: string;
  size: number;
  sha256: string;
}

export interface ReceiveArtifactOptions {
  overwrite?: boolean;
}

export const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;
const MAX_NAME_BYTES = 255;
const OFFER_KEYS = ['id', 'name', 'mime', 'size', 'sha256'] as const;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
// Mimes Awrit captures and exports actually produce: PNG/JSON evidence, the images the
// terminal can inline, and plain text.
const ALLOWED_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/json',
  'text/plain',
]);

function invalid(reason: string): never {
  throw new Error(`invalid artifact offer: ${reason}`);
}

export function validateArtifactName(value: unknown): string {
  if (typeof value !== 'string') invalid('name must be a string');
  if (value === '' || value === '.' || value === '..') invalid('name must be a file basename');
  if (value.includes('/') || value.includes('\\'))
    invalid('name must not contain a path separator');
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      invalid('name must not contain control characters');
    }
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_NAME_BYTES) {
    invalid(`name must be at most ${MAX_NAME_BYTES} bytes`);
  }
  return value;
}

/** Validates an artifact offer received from an untrusted remote host. */
export function parseArtifactOffer(value: unknown): ArtifactOffer {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid('expected an object');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== OFFER_KEYS.length || !OFFER_KEYS.every((key) => keys.includes(key))) {
    invalid(`expected exactly the keys ${OFFER_KEYS.join(', ')}`);
  }

  const { id, name, mime, size, sha256 } = record;
  if (typeof id !== 'string' || !ID_PATTERN.test(id)) invalid('malformed id');
  const safeName = validateArtifactName(name);
  if (typeof mime !== 'string' || !ALLOWED_MIME.has(mime)) invalid('unsupported mime type');
  if (
    typeof size !== 'number' ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > MAX_ARTIFACT_BYTES
  ) {
    invalid(`size must be an integer between 0 and ${MAX_ARTIFACT_BYTES} bytes`);
  }
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    invalid('sha256 must be 64 lowercase hex characters');
  }

  return { id, name: safeName, mime, size, sha256 };
}

async function lstatIfExists(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function writeAll(handle: fs.FileHandle, chunk: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset, null);
    if (bytesWritten <= 0) throw new Error('failed to write artifact data');
    offset += bytesWritten;
  }
}

/**
 * Streams an offered artifact into a private temp file in `destDir`, verifies its size and
 * sha256, then renames it atomically to `destDir/name`. Returns the absolute path only after
 * the rename. Any failure removes the temp file and leaves the destination untouched.
 */
export async function receiveArtifact(
  offer: ArtifactOffer,
  chunks: AsyncIterable<Uint8Array>,
  destDir: string,
  options: ReceiveArtifactOptions = {},
): Promise<string> {
  const verified = parseArtifactOffer(offer);

  const dirStat = await fs.lstat(destDir);
  if (dirStat.isSymbolicLink()) {
    throw new Error(`refusing artifact destination: ${destDir} is a symbolic link`);
  }
  if (!dirStat.isDirectory()) {
    throw new Error(`refusing artifact destination: ${destDir} is not a directory`);
  }

  const finalPath = path.resolve(destDir, verified.name);
  const targetStat = await lstatIfExists(finalPath);
  if (targetStat) {
    if (targetStat.isSymbolicLink()) {
      throw new Error(`refusing artifact target: ${finalPath} is a symbolic link`);
    }
    if (!options.overwrite) {
      throw new Error(`refusing artifact target: ${finalPath} already exists`);
    }
  }

  const tempPath = path.join(destDir, `.awrit-artifact-${randomBytes(8).toString('hex')}.partial`);
  const handle = await fs.open(tempPath, 'wx', 0o600);
  let closed = false;
  let published = false;
  const closeHandle = async () => {
    if (!closed) {
      closed = true;
      await handle.close().catch(() => {});
    }
  };

  try {
    const hash = createHash('sha256');
    let received = 0;
    for await (const chunk of chunks) {
      if (!(chunk instanceof Uint8Array)) throw new Error('artifact chunk is not a byte array');
      received += chunk.byteLength;
      if (received > verified.size) {
        throw new Error(`artifact exceeds declared size of ${verified.size} bytes`);
      }
      hash.update(chunk);
      await writeAll(handle, chunk);
    }

    if (received !== verified.size) {
      throw new Error(
        `artifact size mismatch: expected ${verified.size} bytes, received ${received}`,
      );
    }
    const digest = hash.digest('hex');
    if (digest !== verified.sha256) {
      throw new Error(`artifact hash mismatch: expected ${verified.sha256}, received ${digest}`);
    }

    // A failed close can mean unflushed bytes; it must not publish.
    closed = true;
    await handle.close();
    await fs.rename(tempPath, finalPath);
    published = true;
    return finalPath;
  } finally {
    if (!published) {
      await closeHandle();
      await fs.unlink(tempPath).catch(() => {});
    }
  }
}
