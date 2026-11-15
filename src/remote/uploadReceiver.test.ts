import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createUploadReceiver, sweepStaleUploads } from './uploadReceiver';
import { openChosenUpload } from './uploadSource';

const bytes = Buffer.from('chosen local file');
const offer = {
  id: 'upload-1',
  name: 'chosen.txt',
  mime: 'text/plain',
  size: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
};
async function* chunks() {
  yield bytes;
}

test('successful installation retains verified bytes until explicit disposal', async () => {
  const receiver = createUploadReceiver(offer, new AbortController().signal);
  let installed = '';
  const retained = await receiver.receive(receiver.token, chunks(), async (file) => {
    installed = file;
    expect(await fs.readFile(file)).toEqual(bytes);
    expect((await fs.stat(file)).mode & 0o077).toBe(0);
    expect((await fs.stat(new URL('.', `file://${file}`))).mode & 0o077).toBe(0);
  });
  expect(await fs.readFile(installed)).toEqual(bytes);
  await retained.dispose();
  await retained.dispose();
  await expect(fs.stat(installed)).rejects.toThrow();
  await expect(receiver.receive(receiver.token, chunks(), async () => {})).rejects.toThrow(
    'consumed',
  );
});

test('chosen-file source transfers exact bytes into a verified private receiver', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'awrit-upload-integration-'));
  try {
    const file = path.join(directory, 'chosen.txt');
    await fs.writeFile(file, bytes);
    const source = await openChosenUpload(file);
    try {
      const receiver = createUploadReceiver(
        { id: 'chosen-1', mime: 'text/plain', ...source.metadata },
        new AbortController().signal,
      );
      const retained = await receiver.receive(
        receiver.token,
        source.chunks(),
        async (installed) => {
          expect(installed).not.toBe(file);
          expect(await fs.readFile(installed)).toEqual(bytes);
        },
      );
      await retained.dispose();
    } finally {
      await source.close();
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test('invalid token cannot consume a grant or read bytes', async () => {
  const receiver = createUploadReceiver(offer, new AbortController().signal);
  let read = false;
  async function* payload() {
    read = true;
    yield bytes;
  }
  await expect(receiver.receive('wrong', payload(), async () => {})).rejects.toThrow('token');
  expect(read).toBe(false);
  const retained = await receiver.receive(receiver.token, chunks(), async () => {});
  await retained.dispose();
});

test('size/hash failure consumes the grant and never installs', async () => {
  const receiver = createUploadReceiver(
    { ...offer, sha256: '0'.repeat(64) },
    new AbortController().signal,
  );
  let installed = false;
  await expect(
    receiver.receive(receiver.token, chunks(), async () => {
      installed = true;
    }),
  ).rejects.toThrow('hash');
  expect(installed).toBe(false);
  await expect(receiver.receive(receiver.token, chunks(), async () => {})).rejects.toThrow(
    'consumed',
  );
});

test('navigation cancellation refuses an unused grant without reading bytes', async () => {
  const controller = new AbortController();
  const receiver = createUploadReceiver(offer, controller.signal);
  controller.abort();
  let read = false;
  async function* payload() {
    read = true;
    yield bytes;
  }
  await expect(receiver.receive(receiver.token, payload(), async () => {})).rejects.toThrow(
    'canceled',
  );
  expect(read).toBe(false);
});

test('cancel while receiving prevents installation', async () => {
  const controller = new AbortController();
  const receiver = createUploadReceiver(offer, controller.signal);
  async function* payload() {
    yield bytes;
    controller.abort();
  }
  let installed = false;
  await expect(
    receiver.receive(receiver.token, payload(), async () => {
      installed = true;
    }),
  ).rejects.toThrow('canceled');
  expect(installed).toBe(false);
});

test('abort interrupts a stalled transport without waiting for its next chunk', async () => {
  const controller = new AbortController();
  const receiver = createUploadReceiver(offer, controller.signal);
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  async function* stalled(): AsyncGenerator<Uint8Array> {
    started();
    await new Promise(() => {});
  }
  const receiving = receiver.receive(receiver.token, stalled(), async () => {
    throw new Error('must not install');
  });
  await ready;
  controller.abort();
  await expect(receiving).rejects.toThrow('canceled');
}, 2000);

test('abort during a stalled installation removes its temporary file', async () => {
  const controller = new AbortController();
  const receiver = createUploadReceiver(offer, controller.signal);
  let file = '';
  let started: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const receiving = receiver.receive(receiver.token, chunks(), async (chosen) => {
    file = chosen;
    started();
    await new Promise(() => {});
  });
  await ready;
  controller.abort();
  await expect(receiving).rejects.toThrow('canceled');
  await expect(fs.stat(file)).rejects.toThrow();
}, 2000);

test('installation failure removes the verified temporary file', async () => {
  const receiver = createUploadReceiver(offer, new AbortController().signal);
  let file = '';
  await expect(
    receiver.receive(receiver.token, chunks(), async (chosen) => {
      file = chosen;
      throw new Error('page closed');
    }),
  ).rejects.toThrow('page closed');
  await expect(fs.stat(file)).rejects.toThrow();
});

test('a simultaneous replay cannot race the first transfer', async () => {
  const receiver = createUploadReceiver(offer, new AbortController().signal);
  let release: () => void = () => {};
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  async function* payload() {
    await waiting;
    yield bytes;
  }
  const first = receiver.receive(receiver.token, payload(), async () => {});
  await expect(receiver.receive(receiver.token, chunks(), async () => {})).rejects.toThrow(
    'consumed',
  );
  release();
  const retained = await first;
  await retained.dispose();
});

test('sweep removes only same-user upload dirs of dead owners', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awrit-sweep-test-'));
  try {
    const dead = path.join(root, 'awrit-upload-999999-a');
    const live = path.join(root, 'awrit-upload-424242-b');
    const own = path.join(root, `awrit-upload-${process.pid}-c`);
    const other = path.join(root, 'unrelated-999999-d');
    const target = path.join(root, 'target');
    for (const dir of [dead, live, own, other, target]) await fs.mkdir(dir);
    await fs.writeFile(path.join(dead, 'chosen.txt'), 'left behind');
    await fs.symlink(target, path.join(root, 'awrit-upload-999998-e'));
    await sweepStaleUploads((pid) => pid === 424242, root);
    expect((await fs.readdir(root)).sort()).toEqual(
      [
        'awrit-upload-424242-b',
        `awrit-upload-${process.pid}-c`,
        'awrit-upload-999998-e',
        'target',
        'unrelated-999999-d',
      ].sort(),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
