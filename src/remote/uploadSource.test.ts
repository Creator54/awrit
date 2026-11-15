import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_UPLOAD_BYTES, openChosenUpload } from './uploadSource';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awrit-upload-source-'));
  roots.push(root);
  return root;
}
async function read(chunks: AsyncIterable<Uint8Array>) {
  const buffers: Buffer[] = [];
  for await (const chunk of chunks) buffers.push(Buffer.from(chunk));
  return Buffer.concat(buffers);
}

test('chosen file yields bounded metadata without its path and exact bytes', async () => {
  const root = await fixture();
  const file = path.join(root, 'chosen.txt');
  const bytes = Buffer.from('explicitly chosen\n');
  await fs.writeFile(file, bytes);
  const source = await openChosenUpload(file);
  try {
    expect(source.metadata).toEqual({
      name: 'chosen.txt',
      size: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    expect(await read(source.chunks())).toEqual(bytes);
    await expect(read(source.chunks())).rejects.toThrow('already consumed');
  } finally {
    await source.close();
  }
});

test('replacement of the path cannot send a different file', async () => {
  const root = await fixture();
  const file = path.join(root, 'chosen.txt');
  await fs.writeFile(file, 'chosen');
  const source = await openChosenUpload(file);
  try {
    await fs.rename(file, path.join(root, 'original.txt'));
    await fs.writeFile(file, 'not chosen');
    // Renaming changes ctime: fail closed instead of following the replacement path.
    await expect(read(source.chunks())).rejects.toThrow('changed');
  } finally {
    await source.close();
  }
});

test('rejects symlinks, directories, missing files and oversized sparse files', async () => {
  const root = await fixture();
  const file = path.join(root, 'large');
  await fs.writeFile(file, '');
  await fs.truncate(file, MAX_UPLOAD_BYTES + 1);
  const link = path.join(root, 'link');
  await fs.symlink(file, link);
  await expect(openChosenUpload(file)).rejects.toThrow('too large');
  await expect(openChosenUpload(link)).rejects.toThrow();
  await expect(openChosenUpload(root)).rejects.toThrow('regular file');
  await expect(openChosenUpload(path.join(root, 'missing'))).rejects.toThrow();
});

test('rejects a FIFO without waiting for a writer', async () => {
  const file = path.join(await fixture(), 'pipe');
  execFileSync('mkfifo', [file]);
  await expect(openChosenUpload(file)).rejects.toThrow('regular file');
}, 2000);

test('rejects a basename containing terminal controls', async () => {
  const file = path.join(await fixture(), 'bad\x1bname');
  await fs.writeFile(file, 'secret');
  await expect(openChosenUpload(file)).rejects.toThrow('name');
});

test('detects changes after metadata was hashed and closes after failure', async () => {
  const file = path.join(await fixture(), 'chosen');
  await fs.writeFile(file, 'original');
  const source = await openChosenUpload(file);
  await fs.writeFile(file, 'modified');
  await expect(read(source.chunks())).rejects.toThrow('changed');
  await source.close();
});

test('streams bounded chunks and closes the descriptor when the receiver cancels', async () => {
  const file = path.join(await fixture(), 'large');
  const bytes = Buffer.alloc(200_000, 0x61);
  await fs.writeFile(file, bytes);
  const complete = await openChosenUpload(file);
  let total = 0;
  for await (const chunk of complete.chunks()) {
    expect(chunk.length).toBeLessThanOrEqual(64 * 1024);
    total += chunk.length;
  }
  expect(total).toBe(bytes.length);
  const interrupted = await openChosenUpload(file);
  for await (const _chunk of interrupted.chunks()) break;
  await interrupted.close();
  await expect(read(interrupted.chunks())).rejects.toThrow('already consumed');
});

test('detects an in-place mutation while streaming instead of silently succeeding', async () => {
  const file = path.join(await fixture(), 'changing');
  await fs.writeFile(file, Buffer.alloc(200_000, 0x61));
  const source = await openChosenUpload(file);
  const stream = source.chunks()[Symbol.asyncIterator]();
  try {
    expect((await stream.next()).done).toBe(false);
    await fs.writeFile(file, Buffer.alloc(200_000, 0x62));
    await expect(
      (async () => {
        while (!(await stream.next()).done) {}
      })(),
    ).rejects.toThrow('changed');
  } finally {
    await source.close();
  }
});

test('empty files are valid; cancel closes the source without sending bytes', async () => {
  const file = path.join(await fixture(), 'empty');
  await fs.writeFile(file, '');
  const source = await openChosenUpload(file);
  expect(source.metadata.size).toBe(0);
  expect(await read(source.chunks())).toEqual(Buffer.alloc(0));
  const canceled = await openChosenUpload(file);
  await canceled.close();
  await canceled.close();
  await expect(read(canceled.chunks())).rejects.toThrow('closed');
});
