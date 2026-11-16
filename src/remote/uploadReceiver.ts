import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type ArtifactOffer, parseArtifactOffer, receiveArtifact } from './artifacts';

const UPLOAD_PREFIX = 'awrit-upload-';

/**
 * Removes upload directories left by owners that died before disposing them.
 * Only same-user real directories whose owner pid is gone are touched.
 * Like the supervisor lock, this assumes owners sharing this tmp dir share a
 * pid namespace; a reused pid only delays removal.
 */
export async function sweepStaleUploads(
  alive: (pid: number) => boolean,
  root = os.tmpdir(),
): Promise<void> {
  const pattern = /^awrit-upload-(\d+)-[^/]+$/;
  for (const name of await fs.readdir(root)) {
    const pid = Number(pattern.exec(name)?.[1]);
    if (!pid || pid === process.pid || alive(pid)) continue;
    const entry = path.join(root, name);
    const stat = await fs.lstat(entry).catch(() => undefined);
    if (!stat?.isDirectory() || stat.uid !== process.getuid?.()) continue;
    // One stuck entry must not keep the rest from being removed.
    await fs.rm(entry, { recursive: true, force: true }).catch(() => {});
  }
}

export interface RetainedUpload {
  readonly size: number;
  dispose(): Promise<void>;
}

/** One pending chooser's grant. Successful callers own disposal of retained bytes. */
export function createUploadReceiver(offer: ArtifactOffer, signal: AbortSignal) {
  const verified = parseArtifactOffer(offer);
  const token = randomBytes(32).toString('hex');
  let consumed = false;
  function checkCanceled() {
    if (signal.aborted) throw new Error('Upload canceled');
  }
  return {
    token,
    async receive(
      suppliedToken: string,
      chunks: AsyncIterable<Uint8Array>,
      install: (file: string) => Promise<void>,
    ): Promise<RetainedUpload> {
      const supplied = Buffer.from(suppliedToken);
      const expected = Buffer.from(token);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        throw new Error('Invalid upload token');
      }
      if (consumed) throw new Error('Upload grant already consumed');
      consumed = true;
      checkCanceled();
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), `${UPLOAD_PREFIX}${process.pid}-`));
      let failed = false;
      let failure: unknown;
      try {
        await fs.chmod(directory, 0o700);
        async function* checkedChunks() {
          const iterator = chunks[Symbol.asyncIterator]();
          let cancel: () => void = () => {};
          const canceled = new Promise<never>((_resolve, reject) => {
            cancel = () => reject(new Error('Upload canceled'));
          });
          signal.addEventListener('abort', cancel, { once: true });
          try {
            checkCanceled();
            while (true) {
              const next = await Promise.race([iterator.next(), canceled]);
              checkCanceled();
              if (next.done) break;
              yield next.value;
            }
          } finally {
            signal.removeEventListener('abort', cancel);
            // A stalled transport may never settle next()/return(). Its owner must
            // close the lane on abort; do not let it delay private-file cleanup.
            void iterator.return?.().catch(() => {});
          }
        }
        const file = await receiveArtifact(verified, checkedChunks(), directory);
        checkCanceled();
        // The callback must independently honor the chooser signal before
        // applying the file to a page. Chromium may read it after this resolves.
        let cancel: () => void = () => {};
        const canceled = new Promise<never>((_resolve, reject) => {
          cancel = () => reject(new Error('Upload canceled'));
        });
        signal.addEventListener('abort', cancel, { once: true });
        try {
          checkCanceled();
          await Promise.race([install(file), canceled]);
          checkCanceled();
        } finally {
          signal.removeEventListener('abort', cancel);
        }
      } catch (error) {
        failed = true;
        failure = error;
      }
      if (!failed)
        return {
          size: verified.size,
          dispose: () => fs.rm(directory, { recursive: true, force: true }),
        };
      try {
        await fs.rm(directory, { recursive: true, force: true });
      } catch (cleanupError) {
        if (failed)
          throw new AggregateError(
            [failure, cleanupError],
            'Upload failed and temporary storage cleanup failed',
          );
        throw cleanupError;
      }
      throw failure;
    },
  };
}
