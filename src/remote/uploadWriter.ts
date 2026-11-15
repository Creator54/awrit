import { encodeFrame } from '../browserOwner/protocol';
import type { RemoteLane } from './client';

/** Writes one grant; caller closes source resources and separately awaits owner completion. */
export async function writeUpload(
  lane: RemoteLane,
  chooser: string,
  token: string,
  chunks: AsyncIterable<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  const iterator = chunks[Symbol.asyncIterator]();
  let ended = false;
  let stopped = false;
  let rejectFailure: (error: Error) => void = () => {};
  let resolveClosed: () => void = () => {};
  const failure = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const onError = (error: Error) => rejectFailure(error);
  const onAbort = () => rejectFailure(new Error('Upload canceled'));
  lane.stdin.on('error', onError);
  lane.stdout.on('error', onError);
  lane.stdout.on('data', onUnexpected);
  function onUnexpected() {
    rejectFailure(new Error('Unexpected upload response bytes'));
  }
  lane.onClose((reason) => {
    if (reason || !ended)
      rejectFailure(new Error(reason ?? 'Upload lane closed before end marker'));
    else resolveClosed();
  });
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
  const write = async (frame: Buffer) => {
    if (stopped || signal.aborted) throw new Error('Upload canceled');
    let drain: () => void = () => {};
    const drained = new Promise<void>((resolve) => {
      drain = resolve;
    });
    lane.stdin.once('drain', drain);
    try {
      if (!lane.stdin.write(frame)) await Promise.race([drained, failure]);
    } finally {
      lane.stdin.off('drain', drain);
    }
  };
  try {
    await Promise.race([
      (async () => {
        await write(
          encodeFrame(
            'control',
            Buffer.from(JSON.stringify({ type: 'upload-write', chooser, token })),
          ),
        );
        while (true) {
          const next = await Promise.race([iterator.next(), failure]);
          if (next.done) break;
          const chunk = next.value;
          if (signal.aborted || stopped) throw new Error('Upload canceled');
          // One empty output frame is EOF, not an empty source chunk.
          for (let offset = 0; offset < chunk.length; offset += 64 * 1024) {
            await write(
              encodeFrame('output', Buffer.from(chunk.subarray(offset, offset + 64 * 1024))),
            );
          }
        }
        ended = true;
        await write(encodeFrame('output', Buffer.alloc(0)));
        // Do not end stdin: SSH bridge EOF would race the owner's installation.
        await closed;
      })(),
      failure,
    ]);
  } finally {
    stopped = true;
    // A stalled iterator's return may queue behind next; never delay lane teardown.
    try {
      void Promise.resolve(iterator.return?.()).catch(() => {});
    } catch {}
    signal.removeEventListener('abort', onAbort);
    // Keep the error handlers through destruction, including a late SSH EPIPE.
    lane.stdout.off('data', onUnexpected);
    lane.stdin.destroy();
    lane.stdout.destroy();
    lane.kill();
  }
}
