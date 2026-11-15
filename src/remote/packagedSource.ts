import { createHash } from 'node:crypto';
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';

function readBounded(file: string, limit: number): Buffer {
  const fd = openSync(file, 'r');
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > limit)
      throw new Error('Remote source file is too large or not regular');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (!count) throw new Error('Remote source file changed while reading');
      offset += count;
    }
    return bytes;
  } finally {
    closeSync(fd);
  }
}

/** Load only the source artifact shipped beside the trusted local executable. */
export function readPackagedSource(directory: string): { version: string; bytes: Buffer } {
  const raw = readBounded(join(directory, 'manifest.json'), 4096);
  const value: unknown = JSON.parse(raw.toString('utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid remote source manifest');
  const manifest = value as Record<string, unknown>;
  if (
    Object.keys(manifest).sort().join(',') !== 'format,sha256,size,version' ||
    manifest.format !== 1 ||
    typeof manifest.version !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,37}$/.test(manifest.version) ||
    typeof manifest.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256) ||
    typeof manifest.size !== 'number' ||
    !Number.isSafeInteger(manifest.size) ||
    manifest.size <= 0 ||
    manifest.size > 64 * 1024 * 1024
  )
    throw new Error('Invalid remote source manifest');
  const bytes = readBounded(join(directory, 'source.tar'), manifest.size);
  if (
    bytes.length !== manifest.size ||
    createHash('sha256').update(bytes).digest('hex') !== manifest.sha256
  )
    throw new Error('Remote source archive does not match its manifest');
  return { version: `${manifest.version}-s${manifest.sha256.slice(0, 24)}`, bytes };
}
