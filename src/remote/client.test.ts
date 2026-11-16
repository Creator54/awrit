import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { MouseEvent, TermEvent, WindowSize } from 'awrit-native-rs';
import { FrameDecoder } from '../browserOwner/protocol';
import { createTerminalContext } from '../terminal/context';
import type { RemoteClientDeps, RemoteLane } from './client';
import { createRemoteClient } from './client';
import type { ControlMessage, MediaMeta } from './protocol';
import { encodeMediaEnvelope, parseControl } from './protocol';

const SIZE: WindowSize = { cols: 80, rows: 24, width: 1280, height: 720 };
const FEATURES = { keyboard: true, images: true, loadFrame: true, compositeFrame: true };
const SETTINGS = {
  overlay: false,
  design: false,
  transparent: false,
  noPaint: false,
  debugPaint: false,
};

function controlFrame(value: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(value));
  const frame = Buffer.allocUnsafe(5 + payload.length);
  frame.writeUInt32BE(payload.length + 1, 0);
  frame[4] = 1;
  frame.set(payload, 5);
  return frame;
}

function decodeControl(chunks: Buffer[]): ControlMessage[] {
  const decoder = new FrameDecoder();
  return chunks
    .flatMap((chunk) => decoder.push(chunk))
    .filter((frame) => frame.kind === 'control')
    .map((frame) => parseControl(JSON.parse(frame.payload.toString('utf8'))));
}

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function mediaMeta(overrides: Partial<MediaMeta> = {}): MediaMeta {
  return {
    session: 'session',
    surface: 'content',
    generation: 3,
    epoch: 0,
    frame: 1,
    codec: 'png',
    width: 4,
    height: 3,
    x: 0,
    y: 0,
    z: 0,
    ...overrides,
  };
}

interface Lane {
  lane: RemoteLane;
  sent: Buffer[];
  stderr: PassThrough;
  close(failure?: string): void;
  kills(): number;
}

function fakeLane(): Lane {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const sent: Buffer[] = [];
  stdin.on('data', (chunk: Buffer) => sent.push(chunk));
  let listener: ((failure?: string) => void) | undefined;
  let killed = 0;
  return {
    lane: {
      stdin,
      stdout,
      stderr,
      onClose: (callback) => {
        listener = callback;
      },
      kill: () => {
        killed += 1;
      },
    },
    sent,
    stderr,
    close: (failure) => listener?.(failure),
    kills: () => killed,
  };
}

interface FakeClock {
  now: number;
  timers: { at: number; run: () => void }[];
  clock: { now: () => number; setTimer: (delayMs: number, run: () => void) => () => void };
}

function fakeClock(start = 0): FakeClock {
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

// Tests that leave a client running end it here, so its renderer temp dir is removed.
const running: Array<() => void> = [];
afterEach(() => {
  for (const stop of running.splice(0)) stop();
});

function setup(
  options: {
    artifactRoot?: string;
    android?: string;
    forward?: number;
    url?: string;
    session?: string;
    chooseUpload?: RemoteClientDeps['chooseUpload'];
  } = {},
) {
  const writes: string[] = [];
  const clipboard: string[] = [];
  const lanes: Lane[] = [];
  const argv: string[][] = [];
  const errors: string[] = [];
  const notices: string[] = [];
  const clock = fakeClock();
  let input: ((event: TermEvent) => void) | undefined;
  let resize: (() => void) | undefined;
  let size = SIZE;
  const terminal = createTerminalContext(
    'remote-client-test',
    SIZE,
    FEATURES,
    (data) => writes.push(data),
    SETTINGS,
  );
  const client = createRemoteClient({
    chooseUpload: options.chooseUpload,
    android: options.android,
    alias: 'phoenix',
    url: options.url ?? 'https://example.com/',
    runtimePath: '/r/awrit',
    ...(options.forward !== undefined ? { forward: options.forward } : {}),
    ...(options.session !== undefined ? { session: options.session } : {}),
    terminal,
    size: () => size,
    clock: clock.clock,
    spawn: (command) => {
      argv.push(command);
      const record = fakeLane();
      lanes.push(record);
      return record.lane;
    },
    input: (handler) => {
      input = handler;
      return () => {
        input = undefined;
      };
    },
    onResize: (handler) => {
      resize = handler;
      return () => {
        resize = undefined;
      };
    },
    writeClipboard: (text) => clipboard.push(text),
    stderr: (line) => errors.push(line),
    notify: (line) => notices.push(line),
    ...(options.artifactRoot ? { artifactRoot: options.artifactRoot } : {}),
  });
  running.push(() =>
    input?.({
      eventType: 'key',
      keyEvent: { code: 'c', modifiers: ['ctrl'], down: true, isCharEvent: false },
    } as TermEvent),
  );
  return {
    client,
    writes,
    clipboard,
    lanes,
    argv,
    errors,
    notices,
    clock,
    input: (event: TermEvent) => input?.(event),
    resize: () => resize?.(),
    setSize(next: WindowSize) {
      size = next;
    },
  };
}

/** Runs the handshake up to a ready owner; returns the live client state. */
function ready(artifactRoot?: string) {
  const state = setup(artifactRoot ? { artifactRoot } : {});
  const done = state.client.run();
  const request = readyRequest(state);
  state.lanes[0]?.lane.stdout.write(
    controlFrame({ type: 'ready', request, session: 'session', generation: 3, token: 'secret1' }),
  );
  return { ...state, done, request };
}

function readyRequest(state: ReturnType<typeof setup>): string {
  const create = decodeControl(state.lanes[0]?.sent ?? []).find(
    (message) => message.type === 'create',
  );
  if (create?.type !== 'create') throw new Error('create was not sent');
  return create.request;
}

function mouse(kind: MouseEvent['kind'], x: number, y: number, button?: MouseEvent['button']) {
  return { eventType: 'mouse', mouseEvent: { kind, x, y, button, modifiers: [] } } as TermEvent;
}

describe('createRemoteClient', () => {
  test('routes Android creation and media to its own owner', () => {
    const state = setup({ android: 'phone', url: 'android://phone' });
    void state.client.run();
    expect(state.argv[0]?.slice(-2)).toEqual(['--kind', 'android']);
    const sent = decodeControl(state.lanes[0]?.sent ?? []);
    expect(sent[1]).toMatchObject({
      type: 'create-android',
      device: 'phone',
      url: 'android://phone',
    });
    const create = sent[1];
    if (!create || create.type !== 'create-android') throw new Error('Missing Android creation');
    state.lanes[0]?.lane.stdout.write(
      controlFrame({
        type: 'ready',
        request: create.request,
        session: 'session',
        generation: 3,
        token: 'secret1',
      }),
    );
    expect(state.argv[1]?.slice(-2)).toEqual(['--kind', 'android']);
  });

  test('sends hello and create with ssh argv on the control lane only', () => {
    const state = setup();
    void state.client.run();

    expect(state.argv).toHaveLength(1);
    expect(state.argv[0]?.slice(0, 2)).toEqual(['-T', '-o']);
    expect(state.argv[0]).toContain('phoenix');
    expect(state.argv[0]?.slice(-2)).toEqual(['--channel', 'control']);

    const sent = decodeControl(state.lanes[0]?.sent ?? []);
    expect(sent.map((message) => message.type)).toEqual(['hello', 'create']);
    expect(sent[0]).toMatchObject({ type: 'hello', version: 1, codecs: ['png'] });
    expect(sent[1]).toMatchObject({ type: 'create', url: 'https://example.com/' });
  });

  test('opens the media lane with the token only after ready', () => {
    const state = setup();
    void state.client.run();
    expect(state.lanes).toHaveLength(1);

    const request = readyRequest(state);
    state.lanes[0]?.lane.stdout.write(
      controlFrame({ type: 'ready', request, session: 'session', generation: 3, token: 'secret1' }),
    );

    expect(state.argv[1]?.slice(-2)).toEqual(['--channel', 'media']);
    expect(decodeControl(state.lanes[1]?.sent ?? [])).toEqual([
      { type: 'media', token: 'secret1' },
    ]);
    const control = decodeControl(state.lanes[0]?.sent ?? []);
    expect(control.some((message) => message.type === 'media')).toBe(false);
    expect(control.at(-1)).toEqual({
      type: 'viewport',
      epoch: 0,
      width: 1280,
      height: 720,
      cols: 80,
      rows: 24,
    });
    expect(state.errors).toEqual([]);
  });

  test('renders media frames and returns credit after the terminal acknowledges', () => {
    const state = ready();
    state.lanes[1]?.lane.stdout.write(encodeMediaEnvelope(mediaMeta(), png(4, 3)));

    const output = state.writes.join('');
    expect(output).toContain('\x1b_Gf=100,t=t');
    expect(decodeControl(state.lanes[0]?.sent ?? []).some((m) => m.type === 'credit')).toBe(false);

    const image = /i=(\d+)/.exec(output)?.[1];
    expect(image).toBeString();
    state.input({ eventType: 'graphics', graphics: { id: `i=${image}`, status: 'OK' } });

    expect(decodeControl(state.lanes[0]?.sent ?? []).at(-1)).toEqual({
      type: 'credit',
      surface: 'content',
    });
  });

  test('returns credit for a frame dropped as a stale epoch', () => {
    const state = ready();
    state.setSize({ cols: 100, rows: 40, width: 1600, height: 960 });
    state.resize();
    state.lanes[1]?.lane.stdout.write(encodeMediaEnvelope(mediaMeta({ epoch: 0 }), png(4, 3)));

    expect(state.writes.join('')).not.toContain('\x1b_Gf=100');
    expect(decodeControl(state.lanes[0]?.sent ?? []).at(-1)).toEqual({
      type: 'credit',
      surface: 'content',
    });
  });

  test('coalesces pointer moves and keeps seq, generation and epoch', () => {
    const state = ready();
    state.input(mouse('mouseDown', 3, 4, 'left'));
    state.input(mouse('mouseMove', 5, 6));
    state.input(mouse('mouseMove', 7, 8));
    state.input(mouse('mouseUp', 7, 8, 'left'));

    const input = decodeControl(state.lanes[0]?.sent ?? []).filter(
      (message) => message.type === 'input',
    );
    expect(input.map((message) => message.type === 'input' && message.seq)).toEqual([0, 1, 2]);
    expect(input.map((message) => message.type === 'input' && message.event)).toEqual([
      { kind: 'pointer', action: 'down', x: 3, y: 4, button: 'left' },
      { kind: 'pointer', action: 'move', x: 7, y: 8 },
      { kind: 'pointer', action: 'up', x: 7, y: 8, button: 'left' },
    ]);
    for (const message of input) {
      if (message.type !== 'input') continue;
      expect(message.generation).toBe(3);
      expect(message.epoch).toBe(0);
    }
  });

  test('forwards a trailing pointer move on the next tick', async () => {
    const state = ready();
    state.input(mouse('mouseMove', 2, 3));
    expect(
      decodeControl(state.lanes[0]?.sent ?? []).filter((message) => message.type === 'input'),
    ).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(
      decodeControl(state.lanes[0]?.sent ?? []).filter((message) => message.type === 'input'),
    ).toHaveLength(1);
  });

  test('forwards keys and paste as input events', () => {
    const state = ready();
    state.input({
      eventType: 'key',
      keyEvent: { code: 'a', modifiers: ['shift'], down: true, isCharEvent: true },
    });
    state.input({
      eventType: 'key',
      keyEvent: { code: 'a', modifiers: [], down: false, isCharEvent: true },
    });
    state.input({ eventType: 'paste', paste: 'hello' });

    const input = decodeControl(state.lanes[0]?.sent ?? []).filter(
      (message) => message.type === 'input',
    );
    expect(input.map((message) => message.type === 'input' && message.event)).toEqual([
      { kind: 'key', key: 'a', modifiers: ['shift'] },
      { kind: 'key', key: 'a', up: true },
      { kind: 'text', text: 'hello' },
    ]);
  });

  test('sends a new viewport with the next epoch on resize', () => {
    const state = ready();
    state.setSize({ cols: 100, rows: 40, width: 1600, height: 960 });
    state.resize();

    const viewports = decodeControl(state.lanes[0]?.sent ?? []).filter(
      (message) => message.type === 'viewport',
    );
    expect(viewports).toEqual([
      { type: 'viewport', epoch: 0, width: 1280, height: 720, cols: 80, rows: 24 },
      { type: 'viewport', epoch: 1, width: 1600, height: 960, cols: 100, rows: 40 },
    ]);
  });

  test('ctrl-c sends stop, kills both ssh lanes and restores the terminal', async () => {
    const state = ready();
    expect(state.writes.join('')).toContain('\x1b[?1049h');

    state.input({
      eventType: 'key',
      keyEvent: { code: 'c', modifiers: ['ctrl'], down: true, isCharEvent: false },
    });

    expect(await state.done).toBe(0);
    expect(decodeControl(state.lanes[0]?.sent ?? []).some((m) => m.type === 'stop')).toBe(true);
    // The control lane gets a moment to flush the stop before it is killed.
    expect(state.lanes[0]?.kills()).toBe(0);
    advance(state.clock, 500);
    expect(state.lanes[0]?.kills()).toBe(1);
    expect(state.lanes[1]?.kills()).toBe(1);
    expect(state.writes.join('')).toContain('\x1b[?1049l');
    expect(state.errors).toEqual([]);
  });

  test('ctrl-d detaches, keeps the remote page and prints how to reattach', async () => {
    const state = ready();
    state.input({
      eventType: 'key',
      keyEvent: { code: 'd', modifiers: ['ctrl'], down: true, isCharEvent: false },
    });

    expect(await state.done).toBe(0);
    const sent = decodeControl(state.lanes[0]?.sent ?? []);
    expect(sent.some((m) => m.type === 'detach')).toBe(true);
    expect(sent.some((m) => m.type === 'stop')).toBe(false);
    advance(state.clock, 500);
    expect(state.lanes[0]?.kills()).toBe(1);
    expect(state.writes.join('')).toContain('\x1b[?1049l');
    expect(state.errors).toEqual([
      'Disconnected; the page stays on phoenix for 10 minutes. Reattach: awrit show https://example.com/ --host phoenix --session session',
    ]);
  });

  test('ctrl-d stops a forwarded page, since a new process cannot reuse its port', async () => {
    const state = setup({ forward: 3000, url: 'http://127.0.0.1:3000/' });
    const done = state.client.run();
    state.lanes[0]?.stderr.write('Allocated port 41000 for remote forward to 127.0.0.1:3000\n');
    const request = readyRequest(state);
    state.lanes[0]?.lane.stdout.write(
      controlFrame({ type: 'ready', request, session: 'session', generation: 1, token: 't' }),
    );
    state.input({
      eventType: 'key',
      keyEvent: { code: 'd', modifiers: ['ctrl'], down: true, isCharEvent: false },
    });
    expect(await done).toBe(0);
    const sent = decodeControl(state.lanes[0]?.sent ?? []);
    expect(sent.some((m) => m.type === 'stop')).toBe(true);
    expect(sent.some((m) => m.type === 'detach')).toBe(false);
  });

  test('a given session is attached instead of creating a page', async () => {
    const state = setup({ session: 'kept' });
    const done = state.client.run();
    const sent = decodeControl(state.lanes[0]?.sent ?? []);
    expect(sent.some((m) => m.type === 'create')).toBe(false);
    const attach = sent.find((m) => m.type === 'attach');
    if (attach?.type !== 'attach') throw new Error('attach was not sent');
    expect(attach.session).toBe('kept');
    state.lanes[0]?.lane.stdout.write(
      controlFrame({ type: 'error', code: 'rejected', message: 'Unknown session' }),
    );
    expect(await done).toBe(1);
    expect(state.errors[0]).toContain('Unknown session');
  });

  test('prints one line and exits nonzero when the owner reports an error', async () => {
    const state = setup();
    const done = state.client.run();
    state.lanes[0]?.lane.stdout.write(
      controlFrame({ type: 'error', code: 'busy', message: 'another window is showing this page' }),
    );

    expect(await done).toBe(1);
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]).toContain('another window is showing this page');
    expect(state.writes.join('')).toContain('\x1b[?1049l');
    expect(state.lanes[0]?.kills()).toBe(1);
  });

  test('strips terminal control characters from remote error text', async () => {
    const state = setup();
    const done = state.client.run();
    state.lanes[0]?.lane.stdout.write(
      controlFrame({ type: 'error', code: 'failed', message: 'bad\x1b]2;owned\x07\r\nline' }),
    );

    expect(await done).toBe(1);
    expect(state.errors[0]).toBe('phoenix: bad]2;ownedline');
  });

  test('sends a heartbeat every two seconds while ready', () => {
    const state = ready();
    const beats = () =>
      decodeControl(state.lanes[0]?.sent ?? []).filter((message) => message.type === 'heartbeat');
    expect(beats()).toHaveLength(0);
    advance(state.clock, 2_000);
    expect(beats()).toHaveLength(1);
    advance(state.clock, 4_000);
    expect(beats()).toHaveLength(3);
  });

  test('reattaches with a new generation and request after a control lane loss', () => {
    const state = ready();
    const input = {
      eventType: 'key',
      keyEvent: { code: 'a', modifiers: [], down: true, isCharEvent: true },
    } as TermEvent;
    state.lanes[0]?.close('ssh exited with code 255');
    // Nothing is reported and input is dropped while no lane is attached.
    expect(state.errors).toEqual([]);
    state.input(input);

    advance(state.clock, 1_000);
    expect(state.argv).toHaveLength(3);
    expect(state.argv[2]?.slice(-2)).toEqual(['--channel', 'control']);
    const sent = decodeControl(state.lanes[2]?.sent ?? []);
    expect(sent.map((message) => message.type)).toEqual(['hello', 'attach']);
    const attach = sent[1];
    if (attach?.type !== 'attach') throw new Error('no attach sent');
    expect(attach.session).toBe('session');
    expect(state.lanes[1]?.kills()).toBe(1);

    state.lanes[2]?.lane.stdout.write(
      controlFrame({
        type: 'ready',
        request: attach.request,
        session: 'session',
        generation: 4,
        token: 'secret2',
      }),
    );
    expect(state.argv[3]?.slice(-2)).toEqual(['--channel', 'media']);
    expect(decodeControl(state.lanes[3]?.sent ?? [])).toEqual([
      { type: 'media', token: 'secret2' },
    ]);
    const control = decodeControl(state.lanes[2]?.sent ?? []);
    expect(control.filter((message) => message.type === 'viewport')).toEqual([
      { type: 'viewport', epoch: 0, width: 1280, height: 720, cols: 80, rows: 24 },
    ]);

    // Seq restarts, and input carries the new generation on the new lane.
    state.input(input);
    expect(
      decodeControl(state.lanes[2]?.sent ?? []).filter((message) => message.type === 'input'),
    ).toEqual([
      {
        type: 'input',
        seq: 0,
        generation: 4,
        epoch: 0,
        event: { kind: 'key', key: 'a' },
      },
    ]);
  });

  test('a media lane loss reconnects the same way', () => {
    const state = ready();
    state.lanes[1]?.close();
    advance(state.clock, 1_000);
    expect(state.argv).toHaveLength(3);
    expect(decodeControl(state.lanes[2]?.sent ?? []).map((message) => message.type)).toEqual([
      'hello',
      'attach',
    ]);
  });

  test('shows the connection state in the window title', () => {
    const state = ready();
    const titles = () =>
      state.writes
        .join('')
        .split('\x1b]2;')
        .slice(1)
        .map((part) => part.split('\x07')[0]);
    expect(titles()).toEqual(['phoenix · Connecting · awrit', 'phoenix · Attached · awrit']);

    state.lanes[0]?.close();
    expect(titles().at(-1)).toBe('phoenix · Disconnected, reconnecting · awrit');
  });

  test('dims the last image while disconnected and clears it on reattach', () => {
    const state = ready();
    const shade = /_Gf=100,t=t,[^;]*z=2147483647,c=80,r=24;/;
    expect(state.writes.join('')).not.toMatch(shade);

    state.lanes[0]?.close();
    const lost = state.writes.join('');
    expect(lost).toMatch(shade);
    const id = /i=(\d+),X=0,Y=0,z=2147483647/.exec(lost)?.[1];
    expect(id).toBeDefined();

    advance(state.clock, 1_000);
    const attach = decodeControl(state.lanes[2]?.sent ?? []).find((m) => m.type === 'attach');
    if (attach?.type !== 'attach') throw new Error('no attach sent');
    state.lanes[2]?.lane.stdout.write(
      controlFrame({
        type: 'ready',
        request: attach.request,
        session: 'session',
        generation: 4,
        token: 'secret2',
      }),
    );
    expect(state.writes.join('')).toContain(`\x1b_Ga=d,d=I,i=${id}\x1b\\`);
  });

  test('retries with backoff and fails once the ten minute grace is gone', async () => {
    const state = ready();
    state.lanes[0]?.close();

    advance(state.clock, 3_000);
    // One retry at 1 s and one at 3 s (2 s later).
    expect(state.argv).toHaveLength(4);
    advance(state.clock, 5_000);
    expect(state.argv).toHaveLength(5);

    advance(state.clock, 10 * 60_000);
    expect(await state.done).toBe(1);
    expect(state.errors).toEqual(['phoenix: remote session lost']);
  });

  test('retries a busy reattach until the owner frees the lease', () => {
    const state = ready();
    state.lanes[0]?.close();
    advance(state.clock, 1_000);
    state.lanes[2]?.lane.stdout.write(
      controlFrame({ type: 'error', code: 'busy', message: 'session is busy' }),
    );
    expect(state.errors).toEqual([]);
    expect(state.lanes[2]?.kills()).toBe(1);
    advance(state.clock, 2_000);
    expect(state.argv).toHaveLength(4);
    expect(state.argv[3]?.slice(-2)).toEqual(['--channel', 'control']);
  });

  test('fails without retrying when the reattach is rejected', async () => {
    const state = ready();
    state.lanes[0]?.close();
    advance(state.clock, 1_000);
    state.lanes[2]?.lane.stdout.write(
      controlFrame({ type: 'error', code: 'rejected', message: 'Unknown session' }),
    );

    expect(await state.done).toBe(1);
    expect(state.errors).toEqual(['phoenix: Unknown session']);
    advance(state.clock, 60_000);
    expect(state.argv).toHaveLength(3);
  });

  test('ctrl-c during a reconnect exits 0 and sends no stop', async () => {
    const state = ready();
    state.lanes[0]?.close();
    state.input({
      eventType: 'key',
      keyEvent: { code: 'c', modifiers: ['ctrl'], down: true, isCharEvent: false },
    });

    expect(await state.done).toBe(0);
    expect(state.errors).toEqual([]);
    for (const lane of state.lanes)
      expect(decodeControl(lane.sent).some((message) => message.type === 'stop')).toBe(false);
    expect(state.writes.join('')).toContain('\x1b[?1049l');
  });

  test('prints one line and exits nonzero when a lane closes before ready', async () => {
    const state = setup();
    const done = state.client.run();
    state.lanes[0]?.close();

    expect(await done).toBe(1);
    expect(state.errors).toHaveLength(1);
  });

  test('waits for the allocated port before create and rewrites the url', () => {
    const state = setup({ forward: 3000, url: 'http://localhost:3000/app?q=1#frag' });
    void state.client.run();

    expect(state.argv[0]?.join(' ')).toContain('-R 127.0.0.1:0:127.0.0.1:3000');
    expect(decodeControl(state.lanes[0]?.sent ?? [])).toEqual([]);
    state.lanes[0]?.stderr.write('Warning: Permanently added host\nAllocated port 41');
    state.lanes[0]?.stderr.write('000 for remote forward to 127.0.0.1:3000\n');

    const create = decodeControl(state.lanes[0]?.sent ?? []).find(
      (message) => message.type === 'create',
    );
    expect(create).toMatchObject({
      type: 'create',
      url: 'http://127.0.0.1:41000/app?q=1#frag',
    });
    expect(state.errors).toEqual(['phoenix: http://127.0.0.1:41000/app?q=1#frag']);
  });

  test('fails when ssh never reports the forwarded port', async () => {
    const state = setup({ forward: 3000, url: 'http://127.0.0.1:3000/' });
    const done = state.client.run();
    advance(state.clock, 10_000);

    expect(await done).toBe(1);
    expect(state.errors.at(-1)).toContain('did not report the forwarded port');
    expect(state.lanes[0]?.kills()).toBe(1);
  });

  test('fails when the owner never answers create', async () => {
    const state = setup();
    const done = state.client.run();
    advance(state.clock, 59_000);
    expect(state.lanes[0]?.kills()).toBe(0);
    advance(state.clock, 1_000);

    expect(await done).toBe(1);
    expect(state.errors.at(-1)).toContain('remote owner did not respond');
    expect(state.lanes[0]?.kills()).toBe(1);
  });

  test('cancels the allocation wait when the control lane ends early', async () => {
    const state = setup({ forward: 3000, url: 'http://127.0.0.1:3000/' });
    const done = state.client.run();
    state.lanes[0]?.close('ssh exited with code 255');

    expect(await done).toBe(1);
    state.lanes[0]?.stderr.write('Allocated port 41000 for remote forward to 127.0.0.1:3000\n');
    advance(state.clock, 20_000);
    expect(state.errors).toHaveLength(1);
    expect(
      decodeControl(state.lanes[0]?.sent ?? []).some((message) => message.type === 'create'),
    ).toBe(false);
  });

  test('reattaches to the same allocated port without a new allocation', () => {
    const state = setup({ forward: 3000, url: 'http://localhost:3000/' });
    void state.client.run();
    state.lanes[0]?.stderr.write('Allocated port 41000 for remote forward to 127.0.0.1:3000\n');
    const request = readyRequest(state);
    state.lanes[0]?.lane.stdout.write(
      controlFrame({ type: 'ready', request, session: 'session', generation: 3, token: 'secret1' }),
    );
    state.lanes[0]?.close();
    advance(state.clock, 1_000);

    expect(state.argv).toHaveLength(3);
    expect(state.argv[2]?.join(' ')).toContain('-R 127.0.0.1:41000:127.0.0.1:3000');
    expect(state.argv[2]?.join(' ')).not.toContain('127.0.0.1:0:127.0.0.1:3000');
    expect(decodeControl(state.lanes[2]?.sent ?? []).map((message) => message.type)).toEqual([
      'hello',
      'attach',
    ]);
  });

  test('cancels the allocation timer when the view stops', async () => {
    const state = setup({ forward: 3000, url: 'http://127.0.0.1:3000/' });
    const done = state.client.run();
    state.input({
      eventType: 'key',
      keyEvent: { code: 'c', modifiers: ['ctrl'], down: true, isCharEvent: false },
    });

    expect(await done).toBe(0);
    advance(state.clock, 20_000);
    expect(state.errors).toEqual([]);
    expect(state.lanes[0]?.kills()).toBe(1);
  });

  test('reports a spawn failure as one line and exits nonzero', async () => {
    const state = setup();
    const client = createRemoteClient({
      alias: 'phoenix',
      url: 'https://example.com/',
      runtimePath: '/r/awrit',
      terminal: createTerminalContext('remote-client-test', SIZE, FEATURES, () => {}, SETTINGS),
      size: () => SIZE,
      spawn: () => {
        throw new Error('spawn failed');
      },
      input: () => () => {},
      onResize: () => () => {},
      stderr: (line) => state.errors.push(line),
    });

    expect(await client.run()).toBe(1);
    expect(state.errors).toHaveLength(1);
    expect(state.errors[0]).toContain('spawn failed');
  });
});

describe('remote clipboard copy', () => {
  const copyGesture = (modifiers: string[]) =>
    ({
      eventType: 'key',
      keyEvent: { code: 'c', modifiers, down: true, isCharEvent: false },
    }) as TermEvent;

  test('ignores an unsolicited clipboard message', () => {
    const state = ready();
    state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'clipboard', text: 'sneaky' }));
    expect(state.clipboard).toEqual([]);
  });

  test('copies once after ctrl-shift-c and still forwards the key', () => {
    const state = ready();
    state.input(copyGesture(['ctrl', 'shift']));
    const sent = decodeControl(state.lanes[0]?.sent ?? []);
    expect(
      sent.some(
        (message) =>
          message.type === 'input' && message.event.kind === 'key' && message.event.key === 'c',
      ),
    ).toBe(true);
    expect(sent.some((message) => message.type === 'stop')).toBe(false);

    state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'clipboard', text: 'copied' }));
    state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'clipboard', text: 'again' }));
    expect(state.clipboard).toEqual(['copied']);
  });

  test('arms the same one-shot window for meta-c', () => {
    const state = ready();
    state.input(copyGesture(['meta']));
    state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'clipboard', text: 'mac' }));
    expect(state.clipboard).toEqual(['mac']);
  });

  test('ignores a clipboard message after the two second window', () => {
    const state = ready();
    state.input(copyGesture(['ctrl', 'shift']));
    advance(state.clock, 2_000);
    state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'clipboard', text: 'late' }));
    expect(state.clipboard).toEqual([]);
  });

  test('plain ctrl-c quits without arming a copy', async () => {
    const state = ready();
    state.input(copyGesture(['ctrl']));
    expect(await state.done).toBe(0);
    state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'clipboard', text: 'quit' }));
    expect(state.clipboard).toEqual([]);
  });
});

describe('remote tool requests', () => {
  test('sends one request without any local window id and resolves its result', async () => {
    const state = ready();
    const pending = state.client.call('text', { max: 5 });
    const sent = decodeControl(state.lanes[0]?.sent ?? []);
    const request = sent.find((message) => message.type === 'request');
    if (request?.type !== 'request') throw new Error('no request sent');

    expect(request.tool).toBe('text');
    expect(request.params).toEqual({ max: 5 });
    expect(JSON.stringify(request)).not.toMatch(/sourceWindowId|kittyWindowId|KITTY_WINDOW_ID/);

    state.lanes[0]?.lane.stdout.write(
      controlFrame({ type: 'result', request: request.request, value: { text: 'hi' } }),
    );
    expect(await pending).toEqual({ text: 'hi' });
  });

  test('rejects only the failed request and keeps the session attached', async () => {
    const state = ready();
    const pending = state.client.call('click', { selector: '#a' });
    const sent = decodeControl(state.lanes[0]?.sent ?? []);
    const request = sent.find((message) => message.type === 'request');
    if (request?.type !== 'request') throw new Error('no request sent');

    state.lanes[0]?.lane.stdout.write(
      controlFrame({ type: 'error', request: request.request, code: 'failed', message: 'boom' }),
    );
    await expect(pending).rejects.toThrow('boom');
    expect(state.errors).toEqual([]);
  });

  test('rejects a pending request when the control lane is lost, without replay', async () => {
    const state = ready();
    const pending = state.client.call('snapshot', {});
    state.lanes[0]?.close('ssh exited with code 255');
    await expect(pending).rejects.toThrow('Remote connection lost');
  });

  test('rejects a request while no lane is attached', async () => {
    const state = setup();
    void state.client.run();
    await expect(state.client.call('text', {})).rejects.toThrow('not attached');
  });
});

describe('remote capture artifacts', () => {
  const PNG = Buffer.from('remote-page-png-bytes');

  function offer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'a1',
      name: 'capture.png',
      mime: 'image/png',
      size: PNG.length,
      sha256: createHash('sha256').update(PNG).digest('hex'),
      url: 'https://example.com/page',
      token: 'read-token',
      inputWidth: 640,
      inputHeight: 480,
      ...overrides,
    };
  }

  function tick(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Waits for async setup (a fresh temp dir) before the bulk lane is spawned. */
  async function waitFor(check: () => boolean): Promise<void> {
    for (let attempt = 0; attempt < 100 && !check(); attempt++) await tick();
  }

  async function captureWith(value: Record<string, unknown>, artifactRoot?: string) {
    const state = ready(artifactRoot);
    const pending = state.client.capture({ waitMs: 10 });
    const sent = decodeControl(state.lanes[0]?.sent ?? []);
    const request = sent.find((message) => message.type === 'request');
    if (request?.type !== 'request') throw new Error('no capture request sent');
    expect(request.tool).toBe('capture');
    expect(request.params).toEqual({ waitMs: 10 });

    state.lanes[0]?.lane.stdout.write(
      controlFrame({ type: 'result', request: request.request, value }),
    );
    await waitFor(() => state.argv.at(-1)?.includes('bulk') === true);
    return { state, pending };
  }

  test('reads the offered bytes over a bulk lane and returns them', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-client-artifacts-'));
    try {
      const provenance = { session: 'session-1', generation: 2, epoch: 3 };
      const { state, pending } = await captureWith(offer({ provenance }), root);
      const bulk = state.lanes.at(-1);
      if (!bulk) throw new Error('no bulk lane');
      expect(state.argv.at(-1)?.slice(-2)).toEqual(['--channel', 'bulk']);
      expect(decodeControl(bulk.sent)).toEqual([
        { type: 'artifact', artifact: 'a1', action: 'read', token: 'read-token' },
      ]);
      // Ending stdin would make the remote bridge close before the reply.
      expect(bulk.lane.stdin.writableEnded).toBe(false);

      bulk.lane.stdout.write(PNG);
      bulk.lane.stdout.end();
      const shot = await pending;
      expect(shot.png).toEqual(PNG);
      expect(shot.url).toBe('https://example.com/page');
      expect(shot.inputWidth).toBe(640);
      expect(shot.inputHeight).toBe(480);
      expect(shot.provenance).toEqual(provenance);
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a hash mismatch and publishes nothing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-client-artifacts-'));
    try {
      const { state, pending } = await captureWith(offer({ sha256: 'b'.repeat(64) }), root);
      const bulk = state.lanes.at(-1);
      if (!bulk) throw new Error('no bulk lane');
      bulk.lane.stdout.write(PNG);
      bulk.lane.stdout.end();
      await expect(pending).rejects.toThrow('artifact hash mismatch');
      expect(bulk.lane.stdout.destroyed).toBe(true);
      expect(fs.readdirSync(root)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('accepts any page url the local capture path can persist', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-client-artifacts-'));
    try {
      const { state, pending } = await captureWith(offer({ url: 'about:blank' }), root);
      const bulk = state.lanes.at(-1);
      if (!bulk) throw new Error('no bulk lane');
      bulk.lane.stdout.write(PNG);
      bulk.lane.stdout.end();
      expect((await pending).url).toBe('about:blank');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('times out a stalled bulk read and frees the transfer slot', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-client-artifacts-'));
    try {
      const state = ready(root);
      const stalled = state.client.capture({}, 20);
      const request = decodeControl(state.lanes[0]?.sent ?? []).find(
        (message) => message.type === 'request',
      );
      if (request?.type !== 'request') throw new Error('no capture request sent');
      state.lanes[0]?.lane.stdout.write(
        controlFrame({ type: 'result', request: request.request, value: offer() }),
      );
      await waitFor(() => state.argv.at(-1)?.includes('bulk') === true);
      const first = state.lanes.at(-1);
      if (!first) throw new Error('no bulk lane');

      await expect(stalled).rejects.toThrow('Remote file transfer timed out');
      expect(first.lane.stdout.destroyed).toBe(true);
      expect(first.kills()).toBe(1);

      // The slot is free again: a second capture completes normally.
      const next = state.client.capture({}, 1_000);
      const retry = decodeControl(state.lanes[0]?.sent ?? [])
        .filter((message) => message.type === 'request')
        .at(-1);
      if (retry?.type !== 'request') throw new Error('no capture request sent');
      state.lanes[0]?.lane.stdout.write(
        controlFrame({ type: 'result', request: retry.request, value: offer() }),
      );
      const before = state.lanes.length;
      await waitFor(() => state.lanes.length > before);
      const second = state.lanes.at(-1);
      if (!second || second === first) throw new Error('no second bulk lane');
      second.lane.stdout.write(PNG);
      second.lane.stdout.end();
      expect((await next).png).toEqual(PNG);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects a malformed offer before opening a bulk lane', async () => {
    const state = ready();
    const pending = state.client.capture({});
    const sent = decodeControl(state.lanes[0]?.sent ?? []);
    const request = sent.find((message) => message.type === 'request');
    if (request?.type !== 'request') throw new Error('no capture request sent');
    state.lanes[0]?.lane.stdout.write(
      controlFrame({
        type: 'result',
        request: request.request,
        value: offer({ mime: 'application/x-msdownload' }),
      }),
    );
    await expect(pending).rejects.toThrow('invalid artifact offer');
    expect(state.argv.some((command) => command.includes('bulk'))).toBe(false);
  });

  test('ignores an external link before ready', () => {
    const state = setup();
    void state.client.run();
    state.lanes[0]?.lane.stdout.write(
      controlFrame({ type: 'external-link', url: 'https://example.com/' }),
    );
    expect(state.notices).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  test('notices one external link per attachment', () => {
    const state = ready();
    const frame = controlFrame({ type: 'external-link', url: 'https://example.com/help' });
    state.lanes[0]?.lane.stdout.write(frame);
    state.lanes[0]?.lane.stdout.write(frame);
    expect(state.notices).toEqual([
      'phoenix requested a local browser: https://example.com/help (automatic opening unsupported; open only if trusted)',
    ]);
    expect(state.errors).toEqual([]);
  });

  test('notices an external link again after a reattach', () => {
    const state = ready();
    state.lanes[0]?.lane.stdout.write(
      controlFrame({ type: 'external-link', url: 'https://example.com/help' }),
    );
    expect(state.notices).toHaveLength(1);

    state.lanes[0]?.close('ssh exited with code 255');
    advance(state.clock, 1_000);
    const attach = decodeControl(state.lanes[2]?.sent ?? []).find(
      (message) => message.type === 'attach',
    );
    if (attach?.type !== 'attach') throw new Error('no attach sent');
    state.lanes[2]?.lane.stdout.write(
      controlFrame({
        type: 'ready',
        request: attach.request,
        session: 'session',
        generation: 4,
        token: 'secret2',
      }),
    );
    state.lanes[2]?.lane.stdout.write(
      controlFrame({ type: 'external-link', url: 'https://example.com/help' }),
    );
    expect(state.notices).toHaveLength(2);
  });

  test('ignores a file chooser notice before ready', () => {
    const state = setup();
    void state.client.run();
    state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'file-chooser-unsupported' }));
    expect(state.notices).toEqual([]);
    expect(state.errors).toEqual([]);
  });

  for (const completion of ['ack-first', 'close-first', 'missing-ack'])
    test(`approved upload requires transport close and owner acknowledgement: ${completion}`, async () => {
      let closed = 0;
      const bytes = Buffer.from('approved');
      const state = setup({
        chooseUpload: async (host) => {
          expect(host).toBe('phoenix');
          return {
            mime: 'text/plain',
            source: {
              metadata: {
                name: 'chosen.txt',
                size: bytes.length,
                sha256: createHash('sha256').update(bytes).digest('hex'),
              },
              chunks: async function* () {
                yield bytes;
              },
              close: async () => {
                closed++;
              },
            },
          };
        },
      });
      void state.client.run();
      state.lanes[0]?.lane.stdout.write(
        controlFrame({
          type: 'ready',
          request: readyRequest(state),
          session: 'session',
          generation: 3,
          token: 'secret1',
        }),
      );
      state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'file-chooser', chooser: 'pick' }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        decodeControl(state.lanes[0]?.sent ?? []).some(
          (m) => m.type === 'upload-offer' && m.chooser === 'pick',
        ),
      ).toBe(true);
      state.lanes[0]?.lane.stdout.write(
        controlFrame({ type: 'upload-grant', chooser: 'stale', token: 'grant' }),
      );
      expect(state.lanes).toHaveLength(2);
      state.lanes[0]?.lane.stdout.write(
        controlFrame({ type: 'upload-grant', chooser: 'pick', token: 'grant' }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(state.lanes).toHaveLength(3);
      state.lanes[0]?.lane.stdout.write(
        controlFrame({ type: 'upload-grant', chooser: 'pick', token: 'grant' }),
      );
      expect(state.lanes).toHaveLength(3);
      if (completion === 'ack-first')
        state.lanes[0]?.lane.stdout.write(
          controlFrame({ type: 'upload-complete', chooser: 'pick' }),
        );
      state.lanes[2]?.close();
      await new Promise((resolve) => setImmediate(resolve));
      expect(closed).toBe(1);
      if (completion !== 'ack-first') {
        // A stale acknowledgement cannot free the transfer slot.
        state.lanes[0]?.lane.stdout.write(
          controlFrame({ type: 'upload-complete', chooser: 'stale' }),
        );
        state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'file-chooser', chooser: 'busy' }));
        expect(decodeControl(state.lanes[0]?.sent ?? [])).toContainEqual({
          type: 'upload-cancel',
          chooser: 'busy',
        });
        if (completion === 'close-first')
          state.lanes[0]?.lane.stdout.write(
            controlFrame({ type: 'upload-complete', chooser: 'pick' }),
          );
        else {
          advance(state.clock, 120000);
          expect(decodeControl(state.lanes[0]?.sent ?? [])).toContainEqual({
            type: 'upload-cancel',
            chooser: 'pick',
          });
        }
      }
      state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'file-chooser', chooser: 'next' }));
      await new Promise((resolve) => setImmediate(resolve));
      expect(
        decodeControl(state.lanes[0]?.sent ?? []).some(
          (m) => m.type === 'upload-offer' && m.chooser === 'next',
        ),
      ).toBe(true);
      expect(state.errors).toEqual([]);
    });
  test('an upload that keeps sending chunks outlives the idle deadline', async () => {
    const bytes = Buffer.from('slow');
    const gates: Array<() => void> = [];
    const state = setup({
      chooseUpload: async () => ({
        mime: 'text/plain',
        source: {
          metadata: {
            name: 'slow.txt',
            size: bytes.length,
            sha256: createHash('sha256').update(bytes).digest('hex'),
          },
          chunks: async function* () {
            for (const byte of bytes) {
              await new Promise<void>((resolve) => gates.push(resolve));
              yield Buffer.from([byte]);
            }
          },
          close: async () => {},
        },
      }),
    });
    void state.client.run();
    state.lanes[0]?.lane.stdout.write(
      controlFrame({
        type: 'ready',
        request: readyRequest(state),
        session: 'session',
        generation: 3,
        token: 'secret1',
      }),
    );
    state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'file-chooser', chooser: 'pick' }));
    await new Promise((resolve) => setImmediate(resolve));
    state.lanes[0]?.lane.stdout.write(
      controlFrame({ type: 'upload-grant', chooser: 'pick', token: 'grant' }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    // One chunk every 100 s: 400 s in total, never 120 s idle.
    for (let i = 0; i < bytes.length; i++) {
      advance(state.clock, 100000);
      gates.shift()?.();
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(decodeControl(state.lanes[0]?.sent ?? []).some((m) => m.type === 'upload-cancel')).toBe(
      false,
    );
    expect(state.lanes[2]?.kills()).toBe(0);
  });
  for (const reason of ['navigation', 'disconnect', 'timeout'])
    test(`active upload closes a stalled source after ${reason}`, async () => {
      let closed = 0;
      let nextCalled = false;
      let release: (value: IteratorResult<Buffer>) => void = () => {};
      const state = setup({
        chooseUpload: async () => ({
          mime: 'text/plain',
          source: {
            metadata: { name: 'chosen.txt', size: 1, sha256: '0'.repeat(64) },
            chunks: () => ({
              [Symbol.asyncIterator]() {
                return this;
              },
              next: () =>
                new Promise<IteratorResult<Buffer>>((resolve) => {
                  nextCalled = true;
                  release = resolve;
                }),
            }),
            close: async () => {
              closed++;
            },
          },
        }),
      });
      void state.client.run();
      state.lanes[0]?.lane.stdout.write(
        controlFrame({
          type: 'ready',
          request: readyRequest(state),
          session: 'session',
          generation: 3,
          token: 'secret1',
        }),
      );
      state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'file-chooser', chooser: 'active' }));
      await new Promise((resolve) => setImmediate(resolve));
      state.lanes[0]?.lane.stdout.write(
        controlFrame({ type: 'upload-grant', chooser: 'active', token: 'grant' }),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(state.lanes).toHaveLength(3);
      expect(nextCalled).toBe(true);
      expect(closed).toBe(0);
      if (reason === 'navigation')
        state.lanes[0]?.lane.stdout.write(
          controlFrame({ type: 'upload-cancel', chooser: 'active' }),
        );
      else if (reason === 'disconnect') state.lanes[0]?.close('lost');
      else advance(state.clock, 120000);
      await new Promise((resolve) => setImmediate(resolve));
      expect(closed).toBe(1);
      expect(state.lanes[2]?.kills()).toBe(1);
      const sent = Buffer.concat(state.lanes[2]?.sent ?? []);
      release({ done: false, value: Buffer.from('late bytes') });
      await new Promise((resolve) => setImmediate(resolve));
      expect(Buffer.concat(state.lanes[2]?.sent ?? [])).toEqual(sent);
      expect(closed).toBe(1);
    });
  // No deadline fires while the human browses the native dialog; only the owner can
  // abort a live selection (navigation away, disconnect).
  for (const reason of ['navigation', 'disconnect'])
    test(`late local selection cannot offer after ${reason}`, async () => {
      let release: (
        value: Awaited<ReturnType<NonNullable<RemoteClientDeps['chooseUpload']>>>,
      ) => void = () => {};
      let signal: AbortSignal | undefined;
      let closed = 0;
      const state = setup({
        chooseUpload: async (_host, current) => {
          signal = current;
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      });
      void state.client.run();
      state.lanes[0]?.lane.stdout.write(
        controlFrame({
          type: 'ready',
          request: readyRequest(state),
          session: 'session',
          generation: 3,
          token: 'secret1',
        }),
      );
      state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'file-chooser', chooser: 'pending' }));
      if (reason === 'navigation')
        state.lanes[0]?.lane.stdout.write(
          controlFrame({ type: 'upload-cancel', chooser: 'pending' }),
        );
      else if (reason === 'disconnect') state.lanes[0]?.close('lost');
      expect(signal?.aborted).toBe(true);
      release({
        mime: 'text/plain',
        source: {
          metadata: { name: 'late.txt', size: 0, sha256: createHash('sha256').digest('hex') },
          chunks: async function* () {},
          close: async () => {
            closed++;
          },
        },
      });
      await new Promise((resolve) => setImmediate(resolve));
      expect(closed).toBe(1);
      expect(decodeControl(state.lanes[0]?.sent ?? []).some((m) => m.type === 'upload-offer')).toBe(
        false,
      );
    });
  test('cancels a pending chooser while local selection is unavailable', () => {
    const state = ready();
    state.lanes[0]?.lane.stdout.write(
      controlFrame({ type: 'file-chooser', chooser: 'pending-one' }),
    );
    expect(decodeControl(state.lanes[0]?.sent ?? [])).toContainEqual({
      type: 'upload-cancel',
      chooser: 'pending-one',
    });
  });
  test('notices an unsupported file chooser once per attachment', () => {
    const state = ready();
    const frame = controlFrame({ type: 'file-chooser-unsupported' });
    state.lanes[0]?.lane.stdout.write(frame);
    state.lanes[0]?.lane.stdout.write(frame);
    expect(state.notices).toEqual([
      'phoenix: local file selection and upload are unsupported in this remote viewer; no host file dialog was opened.',
    ]);
    expect(state.errors).toEqual([]);
  });

  test('notices an unsupported file chooser again after a reattach', () => {
    const state = ready();
    state.lanes[0]?.lane.stdout.write(controlFrame({ type: 'file-chooser-unsupported' }));
    expect(state.notices).toHaveLength(1);

    state.lanes[0]?.close('ssh exited with code 255');
    advance(state.clock, 1_000);
    const attach = decodeControl(state.lanes[2]?.sent ?? []).find(
      (message) => message.type === 'attach',
    );
    if (attach?.type !== 'attach') throw new Error('no attach sent');
    state.lanes[2]?.lane.stdout.write(
      controlFrame({
        type: 'ready',
        request: attach.request,
        session: 'session',
        generation: 4,
        token: 'secret2',
      }),
    );
    state.lanes[2]?.lane.stdout.write(controlFrame({ type: 'file-chooser-unsupported' }));
    expect(state.notices).toHaveLength(2);
  });
});
