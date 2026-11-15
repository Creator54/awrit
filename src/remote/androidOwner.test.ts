import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { encodeFrame, FrameDecoder } from '../browserOwner/protocol';
import type { InputEvent, Viewport } from './owner';
import type { RemotePane } from './owner';
import { startAndroidOwner } from './androidOwner';
import { parseControl } from './protocol';
import { supervisorSocketPath } from './supervisor';

/** A pane stub: the supervisor tests never attach a client. */
const idlePane = (): RemotePane => ({ input() {}, resize() {}, close() {} });

async function bounded<T>(pending: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Socket lifecycle timed out')), 2000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-android-owner-'));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('startAndroidOwner', () => {
  test('listens on its own supervisor socket and stops cleanly', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const owner = await startAndroidOwner({ dir, openPane: idlePane });
      try {
        expect(existsSync(supervisorSocketPath(dir))).toBe(true);
      } finally {
        await owner.stop();
      }
      expect(existsSync(supervisorSocketPath(dir))).toBe(false);
    } finally {
      cleanup();
    }
  });

  test('one supervisor per directory', async () => {
    const { dir, cleanup } = tempDir();
    try {
      const first = await startAndroidOwner({ dir, openPane: idlePane });
      try {
        await expect(startAndroidOwner({ dir, openPane: idlePane })).rejects.toThrow(
          'already running',
        );
      } finally {
        await first.stop();
      }
    } finally {
      cleanup();
    }
  });

  test('drives real control socket lifecycle with synthetic release and generation advance', async () => {
    const { dir, cleanup } = tempDir();
    const sockPath = supervisorSocketPath(dir);

    const inputs: InputEvent[] = [];
    const viewports: Viewport[] = [];
    let closed = false;

    let resolvePointerDown!: () => void;
    const pointerDownPromise = new Promise<void>((resolve) => {
      resolvePointerDown = resolve;
    });
    let resolvePointerUp: (() => void) | undefined;
    const pointerUpPromise = new Promise<void>((resolve) => {
      resolvePointerUp = resolve;
    });

    let resolveClosed: (() => void) | undefined;
    const closedPromise = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const injectedPane: RemotePane = {
      input(event: InputEvent) {
        inputs.push(event);
        if (event.kind === 'pointer' && event.action === 'down') resolvePointerDown();
        if (event.kind === 'pointer' && event.action === 'up') {
          resolvePointerUp?.();
        }
      },
      resize(viewport: Viewport) {
        viewports.push(viewport);
      },
      close() {
        closed = true;
        resolveClosed?.();
      },
    };

    const owner = await startAndroidOwner({
      dir,
      openPane: () => injectedPane,
    });

    const build = 'android-socket-fixture';

    const createClient = async () => {
      const sock = connect(sockPath);
      try {
        await bounded(
          new Promise<void>((resolve, reject) => {
            sock.once('connect', resolve);
            sock.once('error', reject);
          }),
        );
      } catch (error) {
        sock.destroy();
        throw error;
      }
      const decoder = new FrameDecoder();
      const messages: ReturnType<typeof parseControl>[] = [];
      let waiter: ((msg: ReturnType<typeof parseControl>) => void) | undefined;

      sock.on('data', (chunk) => {
        const frames = decoder.push(chunk);
        for (const frame of frames) {
          if (frame.kind === 'control') {
            const msg = parseControl(JSON.parse(frame.payload.toString('utf8')));
            if (waiter) {
              const w = waiter;
              waiter = undefined;
              w(msg);
            } else {
              messages.push(msg);
            }
          }
        }
      });

      const nextMessage = (timeoutMs = 2000) => {
        const queued = messages.shift();
        if (queued) return Promise.resolve(queued);
        return new Promise<ReturnType<typeof parseControl>>((resolve, reject) => {
          const timer = setTimeout(() => {
            waiter = undefined;
            reject(new Error(`Timed out waiting for control message (${timeoutMs}ms)`));
          }, timeoutMs);
          waiter = (msg) => {
            clearTimeout(timer);
            resolve(msg);
          };
        });
      };

      const sendControl = (msg: object) => {
        sock.write(encodeFrame('control', Buffer.from(JSON.stringify(msg), 'utf8')));
      };

      return { sock, nextMessage, sendControl };
    };

    let client1: Awaited<ReturnType<typeof createClient>> | undefined;
    let client2: Awaited<ReturnType<typeof createClient>> | undefined;

    try {
      // 1. Connect client 1: hello -> create-android -> ready
      client1 = await createClient();
      client1.sendControl({ type: 'hello', version: 1, build, codecs: ['png'] });
      client1.sendControl({
        type: 'create-android',
        request: 'req-1',
        device: 'emulator-5554',
        url: 'android://emulator-5554',
      });

      const ready1 = await client1.nextMessage();
      expect(ready1.type).toBe('ready');
      if (ready1.type !== 'ready') throw new Error('Expected ready');
      expect(ready1.generation).toBe(1);
      const sessionId = ready1.session;

      // 2. Viewport and primary pointer down
      client1.sendControl({
        type: 'viewport',
        epoch: 1,
        width: 1080,
        height: 1920,
        cols: 80,
        rows: 24,
      });
      client1.sendControl({
        type: 'input',
        seq: 1,
        generation: ready1.generation,
        epoch: 1,
        event: { kind: 'pointer', action: 'down', button: 'left', x: 100, y: 200 },
      });

      await bounded(pointerDownPromise);

      expect(viewports).toHaveLength(1);
      expect(viewports[0].width).toBe(1080);
      expect(inputs).toHaveLength(1);
      expect(inputs[0]).toEqual({
        kind: 'pointer',
        action: 'down',
        button: 'left',
        x: 100,
        y: 200,
      });

      // 3. Destroy control 1 and wait bounded for synthetic pointer up
      client1.sock.destroy();
      await bounded(pointerUpPromise);
      expect(inputs).toContainEqual({
        kind: 'pointer',
        action: 'up',
        button: 'left',
        x: 100,
        y: 200,
      });

      // 4. Real fresh socket hello -> attach -> ready generation advanced
      client2 = await createClient();
      client2.sendControl({ type: 'hello', version: 1, build, codecs: ['png'] });
      client2.sendControl({ type: 'attach', request: 'req-2', session: sessionId });

      const ready2 = await client2.nextMessage();
      expect(ready2.type).toBe('ready');
      if (ready2.type !== 'ready') throw new Error('Expected ready on attach');
      expect(ready2.generation).toBeGreaterThan(ready1.generation);
      expect(ready2.session).toBe(sessionId);

      // 5. stop -> pane closed
      client2.sendControl({ type: 'stop', request: 'req-3' });
      await bounded(closedPromise);
      expect(closed).toBe(true);
    } finally {
      client1?.sock.destroy();
      client2?.sock.destroy();
      await owner.stop();
      cleanup();
    }
  });
});
