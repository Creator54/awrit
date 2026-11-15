import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFileSync, watch } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { encodeFrame } from '../browserOwner/protocol';
import type { FrameSink, FrameSubmit } from './frameSink';
import {
  createOwner,
  type OwnerChannels,
  type PendingFileChooser,
  type Ready,
  type RemotePane,
  toTermEvent,
  type Viewport,
} from './owner';
import { type ControlMessage, decodeMediaEnvelope, type InputEvent, LIMITS } from './protocol';
import { writeUpload } from './uploadWriter';

interface TestPane extends RemotePane {
  url: string;
  id: string;
  sink: FrameSink;
  inputs: InputEvent[];
  viewports: Viewport[];
  closed: boolean;
  onClipboard?: (text: string) => void;
  onExternal?: (url: string) => void;
  onFileChooserUnsupported?: () => void;
  onFileChooser?: (chooser: PendingFileChooser) => void;
}

interface FakeClock {
  now: number;
  timers: { at: number; run: () => void }[];
  clock: { now: () => number; setTimer: (delayMs: number, run: () => void) => () => void };
}

function fakeClock(start = 1_000): FakeClock {
  const state: FakeClock = {
    now: start,
    timers: [],
    clock: {
      now: () => state.now,
      setTimer(delayMs, run) {
        const timer = { at: state.now + delayMs, run };
        state.timers.push(timer);
        return () => {
          const index = state.timers.indexOf(timer);
          if (index !== -1) state.timers.splice(index, 1);
        };
      },
    },
  };
  return state;
}

function setup(onIdle?: () => void) {
  const panes: TestPane[] = [];
  const clock = fakeClock();
  let tokens = 0;
  const errors: string[] = [];
  const owner = createOwner({
    onError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
    now: () => clock.now,
    clock: clock.clock,
    token: () => `token-${++tokens}`,
    encode: async () => Buffer.from('png'),
    ...(onIdle ? { onIdle } : {}),
    openPane: (url, id, sink, onClipboard, onExternal, onFileChooserUnsupported, onFileChooser) => {
      const pane: TestPane = {
        url,
        id,
        sink,
        inputs: [],
        viewports: [],
        closed: false,
        ...(onClipboard ? { onClipboard } : {}),
        ...(onExternal ? { onExternal } : {}),
        ...(onFileChooserUnsupported ? { onFileChooserUnsupported } : {}),
        ...(onFileChooser ? { onFileChooser } : {}),
        input(event) {
          pane.inputs.push(event);
        },
        resize(viewport) {
          pane.viewports.push(viewport);
        },
        close() {
          pane.closed = true;
        },
      };
      panes.push(pane);
      return pane;
    },
  });
  return { owner, panes, clock, errors };
}

/** Runs every fake timer due within `ms`, earliest first, then moves the clock. */
function advance(clock: FakeClock, ms: number): void {
  const target = clock.now + ms;
  for (;;) {
    const due = clock.timers
      .filter((timer) => timer.at <= target)
      .sort((left, right) => left.at - right.at)[0];
    if (!due) break;
    clock.timers.splice(clock.timers.indexOf(due), 1);
    clock.now = due.at;
    due.run();
  }
  clock.now = target;
}

function channels() {
  const state = { controls: [] as ControlMessage[], media: [] as Buffer[], closed: false };
  const api: OwnerChannels = {
    sendControl: (message) => state.controls.push(message),
    sendMedia: (bytes) => state.media.push(bytes),
    close: () => {
      state.closed = true;
    },
  };
  return { state, api };
}

function readyOf(controls: ControlMessage[]): Ready {
  const ready = controls.find((message): message is Ready => message.type === 'ready');
  if (!ready) throw new Error('No ready message');
  return ready;
}

function errorOf(controls: ControlMessage[]): Extract<ControlMessage, { type: 'error' }> {
  const error = controls.find(
    (message): message is Extract<ControlMessage, { type: 'error' }> => message.type === 'error',
  );
  if (!error) throw new Error('No error message');
  return error;
}

function hello(): ControlMessage {
  return { type: 'hello', version: 1, build: 'test', codecs: ['png'] };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
}

function frame(): FrameSubmit {
  return {
    surface: 'content',
    bitmap: Buffer.alloc(2 * 2 * 4, 0xff),
    width: 2,
    height: 2,
    x: 0,
    y: 0,
    z: 0,
  };
}

describe('remote owner', () => {
  test('Android startup gates ready until initialized', async () => {
    let complete!: () => void;
    const ready = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let stopped = false;
    const owner = createOwner({
      android: true,
      openPane: () => ({
        ready,
        input() {},
        resize() {},
        close() {
          stopped = true;
        },
      }),
    });
    const a = channels();
    const control = owner.connect(a.api);
    control.accept(hello());
    control.accept({
      type: 'create-android',
      request: 'r',
      device: 'phone',
      url: 'android://phone',
    });
    expect(a.state.controls.some((message) => message.type === 'ready')).toBe(false);
    complete();
    await settle();
    const accepted = readyOf(a.state.controls);
    expect(accepted.session).toBeTruthy();
    control.accept({ type: 'stop' });
    expect(stopped).toBe(true);
  });

  test('Android initialization failure closes its pane and never sends ready', async () => {
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    let stopped = false;
    const owner = createOwner({
      android: true,
      openPane: () => ({
        ready,
        input() {},
        resize() {},
        close() {
          stopped = true;
        },
      }),
    });
    const a = channels();
    const control = owner.connect(a.api);
    control.accept(hello());
    control.accept({
      type: 'create-android',
      request: 'r',
      device: 'phone',
      url: 'android://phone',
    });
    reject(new Error('No remote device'));
    await settle();
    expect(stopped).toBe(true);
    expect(a.state.controls.some((message) => message.type === 'ready')).toBe(false);
    expect(errorOf(a.state.controls).message).toBe('No remote device');
    control.close();
  });

  test('Android pending startup refuses early attach and later allows a fresh lease', async () => {
    let complete!: () => void;
    const ready = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let session = '';
    const owner = createOwner({
      android: true,
      openPane: (_url, id) => {
        session = id;
        return { ready, input() {}, resize() {}, close() {} };
      },
    });
    const initial = channels();
    const first = owner.connect(initial.api);
    first.accept(hello());
    first.accept({ type: 'create-android', request: 'r', device: 'phone', url: 'android://phone' });
    first.close();
    const early = channels();
    const second = owner.connect(early.api);
    second.accept(hello());
    second.accept({ type: 'attach', request: 'early', session });
    expect(errorOf(early.state.controls).code).toBe('busy');
    complete();
    await settle();
    expect(initial.state.controls.some((m) => m.type === 'ready')).toBe(false);
    second.close();
    const fresh = channels();
    const third = owner.connect(fresh.api);
    third.accept(hello());
    third.accept({ type: 'attach', request: 'fresh', session });
    expect(readyOf(fresh.state.controls).session).toBe(session);
    third.accept({ type: 'stop', request: 'cleanup' });
  });

  test('failed Android startup after disconnect still disposes the pending pane', async () => {
    let reject!: (error: Error) => void;
    const ready = new Promise<void>((_resolve, fail) => {
      reject = fail;
    });
    let stopped = false;
    const owner = createOwner({
      android: true,
      openPane: () => ({
        ready,
        input() {},
        resize() {},
        close() {
          stopped = true;
        },
      }),
    });
    const channel = channels();
    const connection = owner.connect(channel.api);
    connection.accept(hello());
    connection.accept({
      type: 'create-android',
      request: 'r',
      device: 'phone',
      url: 'android://phone',
    });
    connection.close();
    const before = channel.state.controls.length;
    reject(new Error('Device disappeared during initialization'));
    await settle();
    expect(stopped).toBe(true);
    expect(channel.state.controls).toHaveLength(before);
  });

  test('rejects excess sessions without opening another pane or throwing', () => {
    const { owner, panes } = setup();
    for (let index = 0; index < 32; index++) {
      const control = channels();
      const connection = owner.connect(control.api);
      connection.accept(hello());
      connection.accept({ type: 'create', request: `r${index}`, url: 'https://example.com' });
      connection.close();
    }
    const control = channels();
    const connection = owner.connect(control.api);
    connection.accept(hello());
    expect(() =>
      connection.accept({ type: 'create', request: 'excess', url: 'https://example.com' }),
    ).not.toThrow();
    expect(errorOf(control.state.controls).code).toBe('failed');
    expect(control.state.closed).toBe(true);
    expect(panes).toHaveLength(32);
  });

  for (const firstMessage of ['partial', 'hello'])
    test(`new socket deadline handles ${firstMessage} without timing out established lanes`, async () => {
      const { owner, clock } = setup();
      let accepted: net.Socket | undefined;
      const server = net.createServer((socket) => {
        socket.on('error', () => {});
        accepted = socket;
        owner.handleConnection(socket);
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No address');
      const client = net.connect(address.port, '127.0.0.1');
      client.on('error', () => {});
      try {
        await once(client, 'connect');
        if (!accepted) {
          await new Promise<void>((r) => {
            if (accepted) return r();
            server.once('connection', () => r());
          });
        }
        if (!accepted) throw new Error('No accepted socket');
        const received = once(accepted, 'data');
        const bytes = encodeFrame('control', Buffer.from(JSON.stringify(hello())));
        client.write(firstMessage === 'partial' ? bytes.subarray(0, 6) : bytes);
        await received;
        advance(clock, 30000);
        if (firstMessage === 'partial') {
          await once(client, 'close');
          expect(accepted.destroyed).toBe(true);
        } else expect(accepted.destroyed).toBe(false);
      } finally {
        client.destroy();
        accepted?.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });

  test('a classified control lane stalled mid-frame closes at the heartbeat deadline', async () => {
    const { owner, clock } = setup();
    let accepted: net.Socket | undefined;
    const server = net.createServer((socket) => {
      socket.on('error', () => {});
      accepted = socket;
      owner.handleConnection(socket);
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No address');
    const client = net.connect(address.port, '127.0.0.1');
    client.on('error', () => {});
    try {
      await once(client, 'connect');
      if (!accepted) {
        await new Promise<void>((r) => {
          if (accepted) return r();
          server.once('connection', () => r());
        });
      }
      if (!accepted) throw new Error('No accepted socket');
      const received = once(accepted, 'data');
      const partial = encodeFrame('control', Buffer.from(JSON.stringify({ type: 'heartbeat' })));
      client.write(
        Buffer.concat([
          encodeFrame('control', Buffer.from(JSON.stringify(hello()))),
          partial.subarray(0, 6),
        ]),
      );
      await received;
      advance(clock, 5999);
      expect(accepted.destroyed).toBe(false);
      advance(clock, 1);
      await once(client, 'close');
    } finally {
      client.destroy();
      accepted?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test('classifies a connection by its first control frame', () => {
    const { owner } = setup();
    const rejected = channels();
    const connection = owner.connect(rejected.api);
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    expect(errorOf(rejected.state.controls).code).toBe('rejected');
    expect(rejected.state.closed).toBe(true);

    const control = channels();
    const accepted = owner.connect(control.api);
    accepted.accept(hello());
    expect(control.state.controls).toEqual([]);
    expect(control.state.closed).toBe(false);
  });

  test('create opens a page and answers ready with a one-use token', () => {
    const { owner, panes } = setup();
    const control = channels();
    const connection = owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    const ready = readyOf(control.state.controls);
    expect(ready.request).toBe('r1');
    expect(ready.generation).toBe(1);
    expect(ready.token).toBe('token-1');
    expect(panes.map((pane) => pane.url)).toEqual(['https://example.com']);
    expect(panes[0]?.id).toBe(ready.session);
  });

  test('rejects a wrong media token and binds a valid one only once', () => {
    const { owner, errors } = setup();
    const control = channels();
    const connection = owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    const ready = readyOf(control.state.controls);

    const wrong = channels();
    owner.connect(wrong.api).accept({ type: 'media', token: 'not-a-token' });
    expect(wrong.state.controls).toEqual([]);
    expect(wrong.state.closed).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith('media lane rejected');

    const media = channels();
    owner.connect(media.api).accept({ type: 'media', token: ready.token });
    expect(media.state.controls).toEqual([]);
    expect(media.state.closed).toBe(false);

    const reused = channels();
    owner.connect(reused.api).accept({ type: 'media', token: ready.token });
    expect(reused.state.controls).toEqual([]);
    expect(reused.state.closed).toBe(true);
  });

  test('control loss revokes an unused media token without preventing reattach', () => {
    const { owner } = setup();
    const control = channels();
    const connection = owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    const ready = readyOf(control.state.controls);
    connection.close();

    const stale = channels();
    owner.connect(stale.api).accept({ type: 'media', token: ready.token });
    expect(stale.state.closed).toBe(true);

    const nextControl = channels();
    const next = owner.connect(nextControl.api);
    next.accept(hello());
    next.accept({ type: 'attach', request: 'r2', session: ready.session });
    const attached = readyOf(nextControl.state.controls);
    const media = channels();
    owner.connect(media.api).accept({ type: 'media', token: attached.token });
    expect(media.state.closed).toBe(false);
  });

  test('sink frames reach the media lane as media envelopes', async () => {
    const { owner, panes, clock } = setup();
    const control = channels();
    const connection = owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    const ready = readyOf(control.state.controls);

    const media = channels();
    owner.connect(media.api).accept({ type: 'media', token: ready.token });
    panes[0]?.sink.submit(frame());
    await settle();

    expect(media.state.media).toHaveLength(1);
    const decoded = decodeMediaEnvelope(media.state.media[0] as Buffer);
    expect(decoded).toHaveLength(1);
    expect(decoded[0]?.meta.session).toBe(ready.session);
    expect(decoded[0]?.meta.codec).toBe('png');
    expect(decoded[0]?.meta.generation).toBe(ready.generation);
    expect(decoded[0]?.payload).toEqual(Buffer.from('png'));

    // No credit was sent, so the next submit waits; a credit releases it.
    clock.now += 100;
    panes[0]?.sink.submit(frame());
    await settle();
    expect(media.state.media).toHaveLength(1);

    connection.accept({ type: 'credit', surface: 'content' });
    await settle();
    expect(media.state.media).toHaveLength(2);
  });

  test('viewport resizes the pane and input respects generation, seq and epoch', () => {
    const { owner, panes } = setup();
    const control = channels();
    const connection = owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    const ready = readyOf(control.state.controls);
    const pane = panes[0] as TestPane;
    const event: InputEvent = { kind: 'text', text: 'hello' };

    connection.accept({ type: 'viewport', epoch: 2, width: 800, height: 600, cols: 100, rows: 40 });
    expect(pane.viewports).toHaveLength(1);
    expect(pane.viewports[0]?.epoch).toBe(2);

    connection.accept({ type: 'input', seq: 0, generation: ready.generation, epoch: 2, event });
    expect(pane.inputs).toHaveLength(1);
    // Same seq is stale.
    connection.accept({ type: 'input', seq: 0, generation: ready.generation, epoch: 2, event });
    expect(pane.inputs).toHaveLength(1);
    // Old epoch is stale.
    connection.accept({ type: 'input', seq: 1, generation: ready.generation, epoch: 1, event });
    expect(pane.inputs).toHaveLength(1);
    // Old generation is stale.
    connection.accept({ type: 'input', seq: 1, generation: 99, epoch: 2, event });
    expect(pane.inputs).toHaveLength(1);
    connection.accept({ type: 'input', seq: 1, generation: ready.generation, epoch: 2, event });
    expect(pane.inputs).toHaveLength(2);
  });

  test('stop closes the page immediately and control close only detaches', () => {
    const { owner, panes, clock } = setup();
    const stopped = channels();
    const stopping = owner.connect(stopped.api);
    stopping.accept(hello());
    stopping.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    stopping.accept({ type: 'stop', request: 'r1' });
    expect(panes[0]?.closed).toBe(true);
    expect(stopped.state.closed).toBe(true);

    const closed = channels();
    const closing = owner.connect(closed.api);
    closing.accept(hello());
    closing.accept({ type: 'create', request: 'r2', url: 'https://example.org' });
    closing.close();
    expect(panes[1]?.closed).toBe(false);
    expect(closed.state.closed).toBe(true);
    // The page is kept only for the grace, then stops on its own.
    advance(clock, 10 * 60_000);
    expect(panes[1]?.closed).toBe(true);
  });

  test('an owner with no session quits after the idle time, not while one lives', () => {
    let idle = 0;
    const { owner, clock } = setup(() => idle++);
    advance(clock, 10 * 60_000 - 1);
    const lane = channels();
    const control = owner.connect(lane.api);
    control.accept(hello());
    control.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    // Past the first idle deadline; heartbeats are not sent, so stay under the 6 s loss.
    advance(clock, 5_000);
    expect(idle).toBe(0);
    control.accept({ type: 'stop', request: 'r1' });
    advance(clock, 10 * 60_000 - 1);
    expect(idle).toBe(0);
    advance(clock, 1);
    expect(idle).toBe(1);
  });

  test('a missed heartbeat releases held input, detaches and stops media only', () => {
    const { owner, panes, clock, errors } = setup();
    const control = channels();
    const connection = owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    const ready = readyOf(control.state.controls);
    const pane = panes[0] as TestPane;

    const media = channels();
    owner.connect(media.api).accept({ type: 'media', token: ready.token });

    connection.accept({
      type: 'input',
      seq: 0,
      generation: ready.generation,
      epoch: 0,
      event: { kind: 'key', key: 'a' },
    });
    connection.accept({
      type: 'input',
      seq: 1,
      generation: ready.generation,
      epoch: 0,
      event: { kind: 'pointer', action: 'down', x: 5, y: 6, button: 'left' },
    });
    advance(clock, 5_000);
    expect(control.state.closed).toBe(false);

    advance(clock, 1_000);
    expect(pane.inputs.slice(2)).toEqual([
      { kind: 'key', key: 'a', up: true },
      { kind: 'pointer', action: 'up', x: 5, y: 6, button: 'left' },
    ]);
    expect(errors).toContain('released 2 held inputs');
    expect(control.state.closed).toBe(true);
    expect(media.state.closed).toBe(true);
    expect(pane.closed).toBe(false);
  });

  test('a heartbeat keeps the lease and a detach message starts the grace', () => {
    const { owner, panes, clock } = setup();
    const control = channels();
    const connection = owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    const ready = readyOf(control.state.controls);

    advance(clock, 4_000);
    connection.accept({ type: 'heartbeat' });
    advance(clock, 4_000);
    connection.accept({ type: 'heartbeat' });
    advance(clock, 4_000);
    expect(control.state.closed).toBe(false);

    connection.accept({ type: 'detach' });
    expect(control.state.closed).toBe(true);
    expect(panes[0]?.closed).toBe(false);

    // A second controller may attach after a detach, with a new generation.
    const second = channels();
    const reattached = owner.connect(second.api);
    reattached.accept(hello());
    reattached.accept({ type: 'attach', request: 'r2', session: ready.session });
    expect(readyOf(second.state.controls).generation).toBeGreaterThan(ready.generation);
  });

  test('reattach inside the grace gets a new generation and ignores old input', () => {
    const { owner, panes, clock } = setup();
    const control = channels();
    const connection = owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    const ready = readyOf(control.state.controls);
    const pane = panes[0] as TestPane;

    connection.close();
    advance(clock, 10 * 60_000 - 1);
    expect(pane.closed).toBe(false);

    const next = channels();
    const reattached = owner.connect(next.api);
    reattached.accept(hello());
    reattached.accept({ type: 'attach', request: 'r2', session: ready.session });
    const again = readyOf(next.state.controls);
    expect(again.session).toBe(ready.session);
    expect(again.request).toBe('r2');
    expect(again.generation).toBeGreaterThan(ready.generation);
    expect(again.token).not.toBe(ready.token);

    // A reattached client resends its viewport; that repaints, nothing is replayed.
    reattached.accept({ type: 'viewport', epoch: 0, width: 800, height: 600, cols: 100, rows: 40 });
    expect(pane.viewports).toHaveLength(1);

    reattached.accept({
      type: 'input',
      seq: 0,
      generation: ready.generation,
      epoch: 0,
      event: { kind: 'text', text: 'old' },
    });
    expect(pane.inputs).toEqual([]);
    reattached.accept({
      type: 'input',
      seq: 0,
      generation: again.generation,
      epoch: 0,
      event: { kind: 'text', text: 'new' },
    });
    expect(pane.inputs).toEqual([{ kind: 'text', text: 'new' }]);

    // The new media lane binds the fresh token and restores both credits.
    const media = channels();
    owner.connect(media.api).accept({ type: 'media', token: again.token });
    expect(media.state.closed).toBe(false);
    // The paint for that viewport went nowhere; binding asks for a fresh one.
    expect(pane.viewports).toHaveLength(2);
    expect(pane.viewports[1]?.width).toBe(800);

    // The grace timer was cancelled: waiting it out does not stop the page.
    advance(clock, 10 * 60_000);
    expect(pane.closed).toBe(false);
  });

  test('a new client reattaching after a resize gets its viewport and input', () => {
    const { owner, panes } = setup();
    const control = channels();
    const connection = owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    const ready = readyOf(control.state.controls);
    const pane = panes[0] as TestPane;
    connection.accept({ type: 'viewport', epoch: 2, width: 640, height: 480, cols: 80, rows: 24 });
    connection.close();

    // A new client process starts counting viewports from 0 again.
    const next = channels();
    const reattached = owner.connect(next.api);
    reattached.accept(hello());
    reattached.accept({ type: 'attach', request: 'r2', session: ready.session });
    const again = readyOf(next.state.controls);
    reattached.accept({ type: 'viewport', epoch: 0, width: 800, height: 600, cols: 100, rows: 40 });
    expect(pane.viewports.at(-1)?.width).toBe(800);
    reattached.accept({
      type: 'input',
      seq: 0,
      generation: again.generation,
      epoch: 0,
      event: { kind: 'text', text: 'new' },
    });
    expect(pane.inputs).toEqual([{ kind: 'text', text: 'new' }]);
  });

  test('the grace stops only the detached session', () => {
    const { owner, panes, clock } = setup();
    const first = channels();
    const one = owner.connect(first.api);
    one.accept(hello());
    one.accept({ type: 'create', request: 'r1', url: 'https://example.com' });

    const second = channels();
    const two = owner.connect(second.api);
    two.accept(hello());
    two.accept({ type: 'create', request: 'r2', url: 'https://example.org' });
    two.accept({ type: 'heartbeat' });

    one.close();
    advance(clock, 10 * 60_000);
    expect(panes[0]?.closed).toBe(true);
    expect(panes[1]?.closed).toBe(false);

    // The stopped session is gone, so an attach is rejected instead of resurrecting it.
    const late = channels();
    const attaching = owner.connect(late.api);
    attaching.accept(hello());
    attaching.accept({ type: 'attach', request: 'r3', session: (panes[0] as TestPane).id });
    expect(errorOf(late.state.controls).code).toBe('rejected');
  });

  test('a second controller gets busy while the lease is held', () => {
    const { owner } = setup();
    const first = channels();
    const one = owner.connect(first.api);
    one.accept(hello());
    one.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    const ready = readyOf(first.state.controls);

    const other = channels();
    const two = owner.connect(other.api);
    two.accept(hello());
    two.accept({ type: 'attach', request: 'r2', session: ready.session });
    const error = errorOf(other.state.controls);
    expect(error.code).toBe('busy');
    expect(other.state.closed).toBe(true);
    expect(first.state.closed).toBe(false);
  });

  test('a media lane close frees the sink but never detaches', () => {
    const { owner, panes } = setup();
    const control = channels();
    const connection = owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    const ready = readyOf(control.state.controls);
    const pane = panes[0] as TestPane;

    const media = owner.connect(channels().api);
    media.accept({ type: 'media', token: ready.token });
    media.close();

    connection.accept({
      type: 'input',
      seq: 0,
      generation: ready.generation,
      epoch: 0,
      event: { kind: 'text', text: 'still attached' },
    });
    expect(pane.inputs).toEqual([{ kind: 'text', text: 'still attached' }]);
    expect(control.state.closed).toBe(false);
  });

  test('maps remote input to the native terminal event shape', () => {
    expect(toTermEvent({ kind: 'key', key: 'a' })?.keyEvent).toEqual({
      code: 'a',
      modifiers: [],
      down: true,
      isCharEvent: true,
    });
    expect(toTermEvent({ kind: 'key', key: 'a', up: true })?.keyEvent?.down).toBe(false);
    expect(
      toTermEvent({ kind: 'key', key: 'Enter', modifiers: ['ctrl'] })?.keyEvent?.isCharEvent,
    ).toBe(false);
    expect(toTermEvent({ kind: 'text', text: 'hello' })).toEqual({
      eventType: 'paste',
      paste: 'hello',
    });
    expect(
      toTermEvent({ kind: 'pointer', action: 'down', x: 4, y: 5, button: 'left' })?.mouseEvent,
    ).toEqual({ kind: 'mouseDown', button: 'left', x: 4, y: 5, modifiers: [] });
    expect(toTermEvent({ kind: 'wheel', x: 1, y: 2, dx: 0, dy: -3 })?.mouseEvent?.kind).toBe(
      'scrollUp',
    );
    expect(toTermEvent({ kind: 'wheel', x: 1, y: 2, dx: 0, dy: 0 })).toBeNull();
  });

  test('the local owner entry imports remote code only behind --remote-owner', () => {
    const source = readFileSync(path.join(import.meta.dir, '../browserOwner/main.ts'), 'utf8');
    expect(source).not.toMatch(/^import .*from '\.\.\/remote\//m);
    expect(source).toContain("includes('--remote-owner')");
    expect(source).toContain("await import('../remote/owner')");
  });
});

describe('remote owner tool requests', () => {
  function attached() {
    const state = setup();
    const control = channels();
    const connection = state.owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    const pane = state.panes[0];
    if (!pane) throw new Error('no pane opened');
    return { ...state, control, connection, pane };
  }

  test('runs the pane tool and answers with its result', async () => {
    const { control, connection, pane } = attached();
    const calls: unknown[] = [];
    pane.callTool = async (name, params) => {
      calls.push({ name, params });
      return { ok: true, text: 'hi' };
    };
    pane.status = async () => ({ url: 'https://example.com/', loading: true });

    connection.accept({ type: 'request', request: 't1', tool: 'text', params: { max: 5 } });
    await settle();
    expect(calls).toEqual([{ name: 'text', params: { max: 5 } }]);
    expect(control.state.controls.at(-1)).toEqual({
      type: 'result',
      request: 't1',
      value: { ok: true, text: 'hi' },
    });

    connection.accept({ type: 'request', request: 't2', tool: 'status', params: {} });
    await settle();
    expect(control.state.controls.at(-1)).toEqual({
      type: 'result',
      request: 't2',
      value: { url: 'https://example.com/', loading: true },
    });
  });

  test('answers a thrown tool with error and the same request id', async () => {
    const { control, connection, pane } = attached();
    pane.callTool = async () => {
      throw new Error('selector not found');
    };
    connection.accept({
      type: 'request',
      request: 't3',
      tool: 'click',
      params: { selector: '#a' },
    });
    await settle();
    expect(control.state.controls.at(-1)).toEqual({
      type: 'error',
      request: 't3',
      code: 'failed',
      message: 'selector not found',
    });
  });

  test('answers a pane without tools with a failed error', async () => {
    const { control, connection, pane } = attached();
    connection.accept({ type: 'request', request: 't4', tool: 'nope', params: {} });
    await settle();
    const reply = control.state.controls.at(-1);
    if (reply?.type !== 'error') throw new Error('no error reply');
    expect(reply.request).toBe('t4');
    expect(reply.code).toBe('failed');
    expect(pane.callTool).toBeUndefined();
  });

  test('rejects a request before any session is attached', () => {
    const { owner } = setup();
    const control = channels();
    owner.connect(control.api).accept(hello());
    owner.connect(control.api).accept({ type: 'request', request: 't5', tool: 'text', params: {} });
    const error = errorOf(control.state.controls);
    expect(error.code).toBe('rejected');
  });
});

describe('remote owner capture artifacts', () => {
  const PNG = Buffer.from('remote-page-png');
  const DIGEST = createHash('sha256').update(PNG).digest('hex');

  function attached() {
    const state = setup();
    const control = channels();
    const connection = state.owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    const pane = state.panes[0];
    if (!pane) throw new Error('no pane opened');
    pane.capture = async () => ({
      png: PNG,
      url: 'https://example.com/page',
      inputWidth: 640,
      inputHeight: 480,
    });
    return { ...state, control, connection, pane };
  }

  function resultValue(controls: ControlMessage[]): Record<string, unknown> {
    const reply = controls.at(-1);
    if (reply?.type !== 'result') throw new Error('no result reply');
    if (!reply.value || typeof reply.value !== 'object' || Array.isArray(reply.value))
      throw new Error('result is not an object');
    return reply.value as Record<string, unknown>;
  }

  test('rejects a capture completed after the viewport changed', async () => {
    const { control, connection, pane } = attached();
    let finish: (() => void) | undefined;
    pane.capture = () =>
      new Promise((resolve) => {
        finish = () =>
          resolve({ png: PNG, url: 'https://example.com/page', inputWidth: 640, inputHeight: 480 });
      });
    connection.accept({ type: 'request', request: 'stale-capture', tool: 'capture', params: {} });
    await settle();
    connection.accept({ type: 'viewport', epoch: 2, width: 800, height: 600, cols: 100, rows: 40 });
    expect(finish).toBeDefined();
    finish?.();
    await settle();
    expect(
      control.state.controls.some(
        (message) => message.type === 'result' && message.request === 'stale-capture',
      ),
    ).toBe(false);
    expect(errorOf(control.state.controls).code).toBe('failed');
  });

  test('answers a capture with an offer the bulk lane can read once', async () => {
    const { owner, control, connection, pane, errors } = attached();
    const seen: unknown[] = [];
    pane.capture = async (options) => {
      seen.push(options);
      return { png: PNG, url: 'https://example.com/page', inputWidth: 640, inputHeight: 480 };
    };
    connection.accept({ type: 'request', request: 'c1', tool: 'capture', params: { waitMs: 100 } });
    await settle();

    expect(seen).toEqual([{ waitMs: 100 }]);
    const offer = resultValue(control.state.controls);
    expect(offer).toMatchObject({
      name: 'capture.png',
      mime: 'image/png',
      size: PNG.length,
      sha256: DIGEST,
      url: 'https://example.com/page',
      inputWidth: 640,
      inputHeight: 480,
    });
    expect(typeof offer.id).toBe('string');
    expect(typeof offer.token).toBe('string');

    const bulk = channels();
    owner.connect(bulk.api).accept({
      type: 'artifact',
      artifact: String(offer.id),
      action: 'read',
      token: String(offer.token),
    });
    expect(bulk.state.controls).toEqual([]);
    expect(bulk.state.media).toEqual([PNG]);
    expect(bulk.state.closed).toBe(true);

    // One use: the same token cannot read the artifact again.
    const again = channels();
    owner.connect(again.api).accept({
      type: 'artifact',
      artifact: String(offer.id),
      action: 'read',
      token: String(offer.token),
    });
    expect(again.state.media).toEqual([]);
    expect(again.state.closed).toBe(true);
    expect(errors.at(-1)).toContain('bulk lane rejected');
  });

  test('rejects a bad token and an unknown artifact', async () => {
    const { owner, control, connection, errors } = attached();
    connection.accept({ type: 'request', request: 'c1', tool: 'capture', params: {} });
    await settle();
    const { id } = resultValue(control.state.controls);

    const wrong = channels();
    owner.connect(wrong.api).accept({
      type: 'artifact',
      artifact: String(id),
      action: 'read',
      token: 'wrong-token',
    });
    expect(wrong.state.media).toEqual([]);
    expect(wrong.state.closed).toBe(true);

    const unknown = channels();
    owner.connect(unknown.api).accept({
      type: 'artifact',
      artifact: 'missing',
      action: 'read',
      token: 'any-token',
    });
    expect(unknown.state.media).toEqual([]);
    expect(unknown.state.closed).toBe(true);
    expect(errors.filter((line) => line.includes('bulk lane rejected'))).toHaveLength(2);
  });

  test('a new capture replaces the pending one', async () => {
    const { owner, control, connection } = attached();
    connection.accept({ type: 'request', request: 'c1', tool: 'capture', params: {} });
    await settle();
    const first = resultValue(control.state.controls);
    connection.accept({ type: 'request', request: 'c2', tool: 'capture', params: {} });
    await settle();
    const second = resultValue(control.state.controls);

    const stale = channels();
    owner.connect(stale.api).accept({
      type: 'artifact',
      artifact: String(first.id),
      action: 'read',
      token: String(first.token),
    });
    expect(stale.state.media).toEqual([]);

    const fresh = channels();
    owner.connect(fresh.api).accept({
      type: 'artifact',
      artifact: String(second.id),
      action: 'read',
      token: String(second.token),
    });
    expect(fresh.state.media).toEqual([PNG]);
  });

  test('expires a pending capture that is never read', async () => {
    const { owner, control, connection, clock } = attached();
    connection.accept({ type: 'request', request: 'c1', tool: 'capture', params: {} });
    await settle();
    const offer = resultValue(control.state.controls);

    advance(clock, 5 * 60_000);
    const late = channels();
    owner.connect(late.api).accept({
      type: 'artifact',
      artifact: String(offer.id),
      action: 'read',
      token: String(offer.token),
    });
    expect(late.state.media).toEqual([]);
    expect(late.state.closed).toBe(true);
  });

  test('answers a pane without capture and bad options with an error', async () => {
    const { control, connection, pane } = attached();
    pane.capture = undefined;
    connection.accept({ type: 'request', request: 'c1', tool: 'capture', params: {} });
    await settle();
    expect(control.state.controls.at(-1)).toMatchObject({
      type: 'error',
      request: 'c1',
      code: 'failed',
      message: 'Capture is not available for this viewer',
    });

    const invalid = attached();
    invalid.connection.accept({
      type: 'request',
      request: 'c2',
      tool: 'capture',
      params: { waitMs: 60_000 },
    });
    await settle();
    expect(invalid.control.state.controls.at(-1)).toMatchObject({ type: 'error', request: 'c2' });
  });
});

describe('remote owner clipboard', () => {
  function created() {
    const state = setup();
    const control = channels();
    const connection = state.owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'r1', url: 'https://example.com' });
    return { ...state, control, connection };
  }

  test('forwards a pane copy to the attached control lane', () => {
    const { panes, control } = created();
    panes[0]?.onClipboard?.('copied');
    expect(control.state.controls.at(-1)).toEqual({ type: 'clipboard', text: 'copied' });
  });

  test('drops a pane copy with no attached control and targets only a reattached one', () => {
    const { owner, panes, control, connection } = created();
    connection.accept({ type: 'detach' });
    const before = control.state.controls.filter((message) => message.type === 'clipboard').length;
    panes[0]?.onClipboard?.('detached');
    expect(control.state.controls.filter((message) => message.type === 'clipboard')).toHaveLength(
      before,
    );

    const next = channels();
    const reattach = owner.connect(next.api);
    reattach.accept(hello());
    reattach.accept({ type: 'attach', request: 'r2', session: panes[0]?.id ?? 'missing' });
    panes[0]?.onClipboard?.('again');
    expect(next.state.controls.at(-1)).toEqual({ type: 'clipboard', text: 'again' });
    expect(control.state.controls.some((message) => message.type === 'clipboard')).toBe(false);
  });

  test('skips an empty or oversize pane copy', () => {
    const { panes, control } = created();
    const before = control.state.controls.length;
    panes[0]?.onClipboard?.('');
    panes[0]?.onClipboard?.('a'.repeat(LIMITS.clipboard + 1));
    expect(control.state.controls).toHaveLength(before);
  });

  test('forwards an external link from an attached page only', () => {
    const { panes, control, connection } = created();
    panes[0]?.onExternal?.('https://example.com/help');
    expect(control.state.controls.at(-1)).toEqual({
      type: 'external-link',
      url: 'https://example.com/help',
    });

    const before = control.state.controls.length;
    connection.accept({ type: 'detach' });
    panes[0]?.onExternal?.('https://example.com/help');
    expect(control.state.controls).toHaveLength(before);
  });

  test('ignores an external link the protocol would reject', () => {
    const { panes, control } = created();
    const before = control.state.controls.length;
    panes[0]?.onExternal?.('javascript:alert(1)');
    panes[0]?.onExternal?.('https://user:pw@example.com/');
    expect(control.state.controls).toHaveLength(before);
  });

  test('reports an unsupported pane file chooser only while attached', () => {
    const { panes, control, connection } = created();
    panes[0]?.onFileChooserUnsupported?.();
    expect(control.state.controls.at(-1)).toEqual({ type: 'file-chooser-unsupported' });

    const before = control.state.controls.length;
    connection.accept({ type: 'detach' });
    panes[0]?.onFileChooserUnsupported?.();
    expect(control.state.controls).toHaveLength(before);
  });
});

describe('pending upload chooser grants', () => {
  function attached() {
    const state = setup();
    const control = channels();
    const connection = state.owner.connect(control.api);
    connection.accept(hello());
    connection.accept({ type: 'create', request: 'c1', url: 'https://example.com/' });
    return { ...state, control, connection };
  }
  function choose(state: ReturnType<typeof attached>) {
    const controller = new AbortController();
    let canceled = 0;
    state.panes[0]?.onFileChooser?.({
      signal: controller.signal,
      install: async () => {},
      cancel: () => {
        canceled++;
      },
    });
    const message = state.control.state.controls.find((m) => m.type === 'file-chooser');
    if (!message || message.type !== 'file-chooser') throw Error('No chooser request');
    return { controller, chooser: message.chooser, canceled: () => canceled };
  }
  const offer = {
    id: 'u1',
    name: 'chosen.txt',
    mime: 'text/plain',
    size: 0,
    sha256: createHash('sha256').update('').digest('hex'),
  };
  test('only a pending chooser accepts one offer', () => {
    const state = attached();
    const pending = choose(state);
    state.connection.accept({ type: 'upload-offer', chooser: pending.chooser, offer });
    expect(state.control.state.controls.filter((m) => m.type === 'upload-grant')).toHaveLength(1);
    state.connection.accept({ type: 'upload-offer', chooser: pending.chooser, offer });
    expect(state.control.state.controls.filter((m) => m.type === 'upload-grant')).toHaveLength(1);
  });
  for (const end of ['navigation', 'detach', 'cancel', 'stop']) {
    test(`cancels pending chooser on ${end}`, () => {
      const state = attached();
      const pending = choose(state);
      if (end === 'navigation') pending.controller.abort();
      if (end === 'detach') state.connection.close();
      if (end === 'cancel')
        state.connection.accept({ type: 'upload-cancel', chooser: pending.chooser });
      if (end === 'stop') state.connection.accept({ type: 'stop', request: 'stop1' });
      expect(pending.canceled()).toBe(1);
      expect(state.control.state.controls.filter((m) => m.type === 'upload-grant')).toHaveLength(0);
    });
  }
  for (const cleanup of ['navigation', 'stop'])
    test(`a fresh bulk lane retains bytes until ${cleanup}`, async () => {
      const state = attached();
      const pending = choose(state);
      let installed = '';
      const document = new AbortController();
      // Replace the canceled request with a new real installer.
      state.connection.accept({ type: 'upload-cancel', chooser: pending.chooser });
      const payload = Buffer.from('chosen bytes');
      state.panes[0]?.onFileChooser?.({
        signal: document.signal,
        cancel: () => {},
        install: async (file) => {
          installed = file;
          expect(await fs.readFile(file)).toEqual(payload);
        },
      });
      const requests = state.control.state.controls.filter((m) => m.type === 'file-chooser');
      const request = requests.at(-1);
      if (request?.type !== 'file-chooser') throw Error('No chooser');
      state.connection.accept({
        type: 'upload-offer',
        chooser: request.chooser,
        offer: {
          ...offer,
          size: payload.length,
          sha256: createHash('sha256').update(payload).digest('hex'),
        },
      });
      const grant = state.control.state.controls.find((m) => m.type === 'upload-grant');
      if (grant?.type !== 'upload-grant') throw Error('No grant');
      async function* chunks() {
        yield payload;
      }
      const bulk = channels();
      await state.owner.connect(bulk.api).receiveUpload(request.chooser, grant.token, chunks());
      expect(state.control.state.controls.some((m) => m.type === 'upload-complete')).toBe(true);
      expect(await fs.readFile(installed)).toEqual(payload);
      if (cleanup === 'navigation') document.abort();
      else state.connection.accept({ type: 'stop', request: 'cleanup' });
      for (let i = 0; i < 100; i++) {
        try {
          await fs.stat(installed);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await expect(fs.stat(installed)).rejects.toThrow();
      expect(bulk.state.closed).toBe(true);
      await expect(
        state.owner.connect(channels().api).receiveUpload(request.chooser, grant.token, chunks()),
      ).rejects.toThrow('Unknown');
      expect(state.panes[0]?.closed).toBe(cleanup === 'stop');
    });
  test('a bulk lane that stalls mid-upload is aborted and closed at the artifact deadline', async () => {
    const state = attached();
    const pending = choose(state);
    const payload = Buffer.from('chosen bytes');
    state.connection.accept({
      type: 'upload-offer',
      chooser: pending.chooser,
      offer: {
        ...offer,
        size: payload.length,
        sha256: createHash('sha256').update(payload).digest('hex'),
      },
    });
    const grant = state.control.state.controls.find((m) => m.type === 'upload-grant');
    if (grant?.type !== 'upload-grant') throw Error('No grant');
    // Sends a partial body, then never yields or ends.
    async function* stalled() {
      yield payload.subarray(0, 3);
      await new Promise(() => {});
    }
    const bulk = channels();
    const receiving = state.owner
      .connect(bulk.api)
      .receiveUpload(pending.chooser, grant.token, stalled());
    await new Promise((resolve) => setTimeout(resolve, 1));
    // Heartbeats keep the control lane alive, so only the upload deadline can fire.
    for (let ms = 0; ms < 58_000; ms += 2_000) {
      state.connection.accept({ type: 'heartbeat' });
      advance(state.clock, 2_000);
    }
    expect(bulk.state.closed).toBe(false);
    state.connection.accept({ type: 'heartbeat' });
    advance(state.clock, 2_000);
    await expect(receiving).rejects.toThrow();
    expect(bulk.state.closed).toBe(true);
    expect(pending.canceled()).toBe(1);
  });
  test('a chunk arriving after cancel cannot arm a deadline for the next upload', async () => {
    const state = attached();
    const first = choose(state);
    const byte = Buffer.from('x');
    state.connection.accept({
      type: 'upload-offer',
      chooser: first.chooser,
      offer: { ...offer, size: 1, sha256: createHash('sha256').update(byte).digest('hex') },
    });
    const grant = state.control.state.controls.find((m) => m.type === 'upload-grant');
    if (grant?.type !== 'upload-grant') throw Error('No grant');
    let release = () => {};
    let started = () => {};
    const reading = new Promise<void>((resolve) => {
      started = resolve;
    });
    async function* late() {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      yield byte;
    }
    const receiving = state.owner
      .connect(channels().api)
      .receiveUpload(first.chooser, grant.token, late());
    await reading;
    first.controller.abort();
    await expect(receiving).rejects.toThrow();
    release();
    await new Promise((resolve) => setTimeout(resolve, 1));
    const beat = (total: number) => {
      for (let ms = 0; ms < total; ms += 2_000) {
        state.connection.accept({ type: 'heartbeat' });
        advance(state.clock, 2_000);
      }
    };
    // A stray timer armed by the late chunk would fire at 60 s; the second
    // upload's own deadline is at 90 s.
    beat(30_000);
    let canceled = 0;
    state.panes[0]?.onFileChooser?.({
      signal: new AbortController().signal,
      install: async () => {},
      cancel: () => {
        canceled++;
      },
    });
    beat(40_000);
    expect(canceled).toBe(0);
  });
  test('an upload that keeps making progress outlives the idle deadline', async () => {
    const state = attached();
    const pending = choose(state);
    const payload = Buffer.from('0123456789');
    state.connection.accept({
      type: 'upload-offer',
      chooser: pending.chooser,
      offer: {
        ...offer,
        size: payload.length,
        sha256: createHash('sha256').update(payload).digest('hex'),
      },
    });
    const grant = state.control.state.controls.find((m) => m.type === 'upload-grant');
    if (grant?.type !== 'upload-grant') throw Error('No grant');
    const gates: Array<() => void> = [];
    async function* slow() {
      for (const byte of payload) {
        await new Promise<void>((resolve) => gates.push(resolve));
        yield Buffer.from([byte]);
      }
    }
    const receiving = state.owner
      .connect(channels().api)
      .receiveUpload(pending.chooser, grant.token, slow());
    // One byte every 50 s: 500 s in total, never 60 s idle.
    for (let i = 0; i < payload.length; i++) {
      // The next byte is only pulled after the previous one is written to disk.
      while (gates.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      for (let ms = 0; ms < 50_000; ms += 2_000) {
        state.connection.accept({ type: 'heartbeat' });
        advance(state.clock, 2_000);
      }
      gates.shift()?.();
    }
    await receiving;
    expect(pending.canceled()).toBe(0);
  });
  test('retained byte count rejects a new offer before issuing another grant', async () => {
    const state = attached();
    const payload = Buffer.from('x');
    let installed = '';
    state.panes[0]?.onFileChooser?.({
      signal: new AbortController().signal,
      cancel: () => {},
      install: async (file) => {
        installed = file;
      },
    });
    const chooser = state.control.state.controls.find((m) => m.type === 'file-chooser');
    if (chooser?.type !== 'file-chooser') throw Error('No chooser');
    state.connection.accept({
      type: 'upload-offer',
      chooser: chooser.chooser,
      offer: { ...offer, size: 1, sha256: createHash('sha256').update(payload).digest('hex') },
    });
    const grant = state.control.state.controls.find((m) => m.type === 'upload-grant');
    if (grant?.type !== 'upload-grant') throw Error('No grant');
    try {
      await state.owner.connect(channels().api).receiveUpload(
        chooser.chooser,
        grant.token,
        (async function* () {
          yield payload;
        })(),
      );
      state.panes[0]?.onFileChooser?.({
        signal: new AbortController().signal,
        cancel: () => {},
        install: async () => {},
      });
      const next = state.control.state.controls.filter((m) => m.type === 'file-chooser').at(-1);
      if (next?.type !== 'file-chooser') throw Error('No next chooser');
      state.connection.accept({
        type: 'upload-offer',
        chooser: next.chooser,
        offer: { ...offer, size: 256 * 1024 * 1024 },
      });
      expect(state.control.state.controls.filter((m) => m.type === 'upload-grant')).toHaveLength(1);
      expect(errorOf(state.control.state.controls).message).toContain('storage limit');
    } finally {
      state.connection.accept({ type: 'stop', request: 'cleanup' });
      for (let i = 0; i < 100; i++) {
        try {
          await fs.stat(installed);
        } catch {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      await expect(fs.stat(installed)).rejects.toThrow();
    }
  });
  test('retained file count rejects a new offer before issuing another grant', async () => {
    const state = attached();
    const document = new AbortController();
    const paths: string[] = [];
    try {
      for (let i = 0; i < 33; i++) {
        state.panes[0]?.onFileChooser?.({
          signal: document.signal,
          cancel: () => {},
          install: async (file) => {
            paths.push(file);
          },
        });
        const chooser = state.control.state.controls
          .filter((m) => m.type === 'file-chooser')
          .at(-1);
        if (chooser?.type !== 'file-chooser') throw Error('No chooser');
        const grants = state.control.state.controls.filter((m) => m.type === 'upload-grant').length;
        state.connection.accept({ type: 'upload-offer', chooser: chooser.chooser, offer });
        const issued = state.control.state.controls.filter((m) => m.type === 'upload-grant');
        expect(issued.length).toBe(grants + (i < 32 ? 1 : 0));
        if (i === 32) break;
        const grant = issued.at(-1);
        if (grant?.type !== 'upload-grant') throw Error('No grant');
        async function* empty() {}
        await state.owner
          .connect(channels().api)
          .receiveUpload(chooser.chooser, grant.token, empty());
      }
      expect(paths).toHaveLength(32);
      expect(errorOf(state.control.state.controls).message).toContain('storage limit');
      for (const file of paths) expect((await fs.stat(file)).size).toBe(0);
    } finally {
      state.connection.accept({ type: 'stop', request: 'cleanup' });
      for (const file of paths) {
        for (let i = 0; i < 100; i++) {
          try {
            await fs.stat(file);
          } catch {
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        await expect(fs.stat(file)).rejects.toThrow();
      }
    }
  });
  for (const valid of [true, false])
    test(`socket bulk lane verifies framed bytes (valid hash: ${valid})`, async () => {
      const state = attached();
      const payload = Buffer.from('socket upload');
      let installed = false;
      state.panes[0]?.onFileChooser?.({
        signal: new AbortController().signal,
        cancel: () => {},
        install: async (file) => {
          expect(await fs.readFile(file)).toEqual(payload);
          installed = true;
        },
      });
      const chooser = state.control.state.controls.find((m) => m.type === 'file-chooser');
      if (chooser?.type !== 'file-chooser') throw Error('No chooser');
      state.connection.accept({
        type: 'upload-offer',
        chooser: chooser.chooser,
        offer: {
          ...offer,
          size: payload.length,
          sha256: valid ? createHash('sha256').update(payload).digest('hex') : '0'.repeat(64),
        },
      });
      const grant = state.control.state.controls.find((m) => m.type === 'upload-grant');
      if (grant?.type !== 'upload-grant') throw Error('No grant');
      const server = net.createServer((socket) => {
        socket.on('error', () => {});
        state.owner.handleConnection(socket);
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('No address');
      const client = net.connect(address.port, '127.0.0.1');
      client.on('error', () => {});
      try {
        await once(client, 'connect');
        client.write(
          Buffer.concat([
            encodeFrame(
              'control',
              Buffer.from(
                JSON.stringify({
                  type: 'upload-write',
                  chooser: chooser.chooser,
                  token: grant.token,
                }),
              ),
            ),
            encodeFrame('output', payload),
            encodeFrame('output', Buffer.alloc(0)),
          ]),
        );
        await once(client, valid ? 'end' : 'close');
        expect(installed).toBe(valid);
        expect(state.control.state.controls.some((m) => m.type === 'upload-complete')).toBe(valid);
      } finally {
        state.connection.accept({ type: 'stop', request: 'cleanup' });
        client.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  for (const valid of [true, false])
    test(`production writer and owner interoperate over socket (valid: ${valid})`, async () => {
      const state = attached();
      const payload = Buffer.alloc(2 * 1024 * 1024, 73);
      const document = new AbortController();
      let installed: string | undefined;
      state.panes[0]?.onFileChooser?.({
        signal: document.signal,
        cancel: () => {},
        install: async (file) => {
          installed = file;
        },
      });
      const chooser = state.control.state.controls.find((m) => m.type === 'file-chooser');
      if (chooser?.type !== 'file-chooser') throw Error('No chooser');
      state.connection.accept({
        type: 'upload-offer',
        chooser: chooser.chooser,
        offer: {
          ...offer,
          size: payload.length,
          sha256: valid ? createHash('sha256').update(payload).digest('hex') : '0'.repeat(64),
        },
      });
      const grant = state.control.state.controls.find((m) => m.type === 'upload-grant');
      if (grant?.type !== 'upload-grant') throw Error('No grant');
      const server = net.createServer((socket) => {
        socket.on('error', () => {});
        state.owner.handleConnection(socket);
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('No address');
      const socket = net.connect(address.port, '127.0.0.1');
      socket.on('error', () => {});
      try {
        await once(socket, 'connect');
        await writeUpload(
          {
            stdin: socket,
            stdout: socket,
            onClose: (listener) => {
              socket.once('close', (error) => listener(error ? 'Socket failed' : undefined));
            },
            kill: () => {
              socket.destroy();
            },
          },
          chooser.chooser,
          grant.token,
          (async function* () {
            yield payload;
          })(),
          new AbortController().signal,
        );
        expect(state.control.state.controls.some((m) => m.type === 'upload-complete')).toBe(valid);
        if (valid) {
          if (!installed) throw Error('No installed file');
          expect(await fs.readFile(installed)).toEqual(payload);
          const file = installed;
          const deleted = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
              () => reject(Error('Retained upload cleanup timed out')),
              3000,
            );
            const interval = setInterval(() => {
              void fs.access(file).catch(() => {
                cleanup();
                resolve();
              });
            }, 25);
            let watcher: ReturnType<typeof watch> | undefined;
            try {
              watcher = watch(path.dirname(file), () => {
                void fs.access(file).catch(() => {
                  cleanup();
                  resolve();
                });
              });
              watcher.on('error', () => {});
            } catch {}
            function cleanup() {
              clearTimeout(timer);
              clearInterval(interval);
              try {
                watcher?.close();
              } catch {}
            }
          });
          document.abort();
          await deleted;
          expect(
            await fs.access(installed).then(
              () => true,
              () => false,
            ),
          ).toBe(false);
        } else {
          expect(installed).toBeUndefined();
          expect(state.errors.some((error) => error.includes('artifact hash mismatch'))).toBe(true);
        }
      } finally {
        state.connection.accept({ type: 'stop', request: 'cleanup' });
        socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  for (const ending of ['complete', 'disconnect', 'navigation', 'malformed']) {
    test(`large socket upload handles ${ending} without detaching its controller`, async () => {
      const state = attached();
      const payload = Buffer.alloc(2 * 1024 * 1024, 0x61);
      const controller = new AbortController();
      let installed = false;
      let canceled = 0;
      let cancelSeen: () => void = () => {};
      const canceledRequest = new Promise<void>((resolve) => {
        cancelSeen = resolve;
      });
      state.panes[0]?.onFileChooser?.({
        signal: controller.signal,
        cancel: () => {
          canceled++;
          cancelSeen();
        },
        install: async (file) => {
          expect(await fs.readFile(file)).toEqual(payload);
          installed = true;
        },
      });
      const chooser = state.control.state.controls.find((m) => m.type === 'file-chooser');
      if (chooser?.type !== 'file-chooser') throw Error('No chooser');
      state.connection.accept({
        type: 'upload-offer',
        chooser: chooser.chooser,
        offer: {
          ...offer,
          size: payload.length,
          sha256: createHash('sha256').update(payload).digest('hex'),
        },
      });
      const grant = state.control.state.controls.find((m) => m.type === 'upload-grant');
      if (grant?.type !== 'upload-grant') throw Error('No grant');
      let pauses = 0;
      let pauseSeen: () => void = () => {};
      const paused = new Promise<void>((resolve) => {
        pauseSeen = resolve;
      });
      const server = net.createServer((socket) => {
        socket.on('error', () => {});
        const pause = socket.pause.bind(socket);
        socket.pause = () => {
          pauses++;
          pauseSeen();
          return pause();
        };
        state.owner.handleConnection(socket);
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('No address');
      const client = net.connect(address.port, '127.0.0.1');
      client.on('error', () => {});
      try {
        await once(client, 'connect');
        const frames = [
          encodeFrame(
            'control',
            Buffer.from(
              JSON.stringify({
                type: 'upload-write',
                chooser: chooser.chooser,
                token: grant.token,
              }),
            ),
          ),
        ];
        for (let offset = 0; offset < payload.length; offset += 64 * 1024)
          frames.push(encodeFrame('output', payload.subarray(offset, offset + 64 * 1024)));
        if (ending === 'complete') frames.push(encodeFrame('output', Buffer.alloc(0)));
        if (ending === 'malformed')
          frames.push(encodeFrame('control', Buffer.from('{"type":"heartbeat"}')));
        client.write(Buffer.concat(frames));
        if (ending === 'disconnect' || ending === 'navigation') {
          await paused;
          if (ending === 'disconnect') client.destroy();
          else controller.abort();
        }
        if (ending === 'complete' || ending === 'navigation' || ending === 'malformed') {
          client.resume();
          await new Promise<void>((resolve) => {
            if (client.destroyed) return resolve();
            client.once('end', () => resolve());
            client.once('close', () => resolve());
          });
        }
        if (ending !== 'complete') await canceledRequest;
        expect(installed).toBe(ending === 'complete');
        expect(canceled).toBe(ending === 'complete' ? 0 : 1);
        expect(pauses).toBeGreaterThan(0);
        expect(state.panes[0]?.closed).toBe(false);
        expect(state.control.state.closed).toBe(false);
      } finally {
        state.connection.accept({ type: 'stop', request: 'cleanup' });
        client.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 4000);
  }
  test('unknown chooser offers cannot create grants', () => {
    const state = attached();
    state.connection.accept({ type: 'upload-offer', chooser: 'unknown', offer });
    expect(state.control.state.controls.some((m) => m.type === 'upload-grant')).toBe(false);
    expect(errorOf(state.control.state.controls).code).toBe('rejected');
  });
  test('a pending chooser expires even while heartbeats keep the session attached', () => {
    const state = attached();
    const pending = choose(state);
    for (let i = 0; i < 120; i++) {
      state.connection.accept({ type: 'heartbeat' });
      advance(state.clock, 1000);
    }
    expect(pending.canceled()).toBe(1);
    expect(state.control.state.controls.some((m) => m.type === 'upload-cancel')).toBe(true);
  });
  test('detached pages cannot request a local chooser', () => {
    const state = attached();
    state.connection.close();
    let canceled = false;
    state.panes[0]?.onFileChooser?.({
      signal: new AbortController().signal,
      install: async () => {},
      cancel: () => {
        canceled = true;
      },
    });
    expect(canceled).toBe(true);
    expect(state.control.state.controls.some((m) => m.type === 'file-chooser')).toBe(false);
  });
});
