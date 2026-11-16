import { randomBytes } from 'node:crypto';
import { type AdbServerInstance, createAdbControl } from '../adb/adbControl';
import { captureDeviceScreenshot, getAdbSerialForDevice } from '../adb/androidManager';
import { createAndroidHttpTools } from './androidTools';
import type { FrameSink } from './frameSink';
import type { RemotePane, Viewport } from './owner';
import { type InputEvent, toJson } from './protocol';

/** Device names and ADB serials; no whitespace, quoting, or shell characters. */
const DEVICE_NAME = /^[A-Za-z0-9._:@-]{1,128}$/;

/** The remote owner only hosts loopback MJPEG for control; this pane is the pixel path. */
const INITIAL_VIEWPORT = { width: 1280, height: 720 };
// Replaced by the first viewport message; the initial values keep early input mappable.
const INITIAL_COLS = 160;
const INITIAL_ROWS = 45;
const MAX_QUEUE = 24;
const MAX_TEXT = 256;

/** Terminal keys the Android pane can press; modifiers are not sent. */
const KEYCODES: Readonly<Record<string, string>> = {
  enter: 'KEYCODE_ENTER',
  tab: 'KEYCODE_TAB',
  space: 'KEYCODE_SPACE',
  escape: 'KEYCODE_BACK',
  back: 'KEYCODE_BACK',
  up: 'KEYCODE_DPAD_UP',
  down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT',
  right: 'KEYCODE_DPAD_RIGHT',
  arrowup: 'KEYCODE_DPAD_UP',
  arrowdown: 'KEYCODE_DPAD_DOWN',
  arrowleft: 'KEYCODE_DPAD_LEFT',
  arrowright: 'KEYCODE_DPAD_RIGHT',
  home: 'KEYCODE_HOME',
  end: 'KEYCODE_MOVE_END',
  pageup: 'KEYCODE_PAGE_UP',
  pagedown: 'KEYCODE_PAGE_DOWN',
  backspace: 'KEYCODE_DEL',
  delete: 'KEYCODE_FORWARD_DEL',
};

export interface AndroidPaneDeps {
  start?: typeof createAdbControl;
  serialFor?: typeof getAdbSerialForDevice;
  capture?: typeof captureDeviceScreenshot;
  fetch?: typeof fetch;
}

interface ControlRequest {
  path: string;
  body: Record<string, unknown>;
  /** A waiting pointer move is replaced by a newer one. */
  move?: boolean;
  /** A pointer lift is queued even when the queue is full. */
  release?: boolean;
}

export function androidDeviceUrl(device: string): string {
  if (!DEVICE_NAME.test(device)) throw new Error('Invalid Android device name');
  return `android://${encodeURIComponent(device)}`;
}

export function androidDeviceFromUrl(url: string): string {
  if (typeof url !== 'string' || !url) throw new Error('Invalid Android device URL');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('Invalid Android device URL');
  }
  if (
    parsed.protocol !== 'android:' ||
    !parsed.hostname ||
    parsed.pathname ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    parsed.port
  ) {
    throw new Error('Invalid Android device URL');
  }
  let device: string;
  try {
    device = decodeURIComponent(parsed.hostname);
  } catch {
    throw new Error('Invalid Android device URL');
  }
  if (!DEVICE_NAME.test(device) || encodeURIComponent(device) !== parsed.hostname) {
    throw new Error('Invalid Android device URL');
  }
  return device;
}

function clamp(value: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.round(value)));
}

/**
 * Creates a remote Android pane that streams device frames through the existing ADB
 * screenrecord/FFmpeg pipeline and forwards input to its loopback control server.
 */
export function createAndroidPane(
  device: string,
  sink: FrameSink,
  deps: AndroidPaneDeps = {},
): RemotePane {
  if (!DEVICE_NAME.test(device)) throw new Error('Invalid Android device name');
  const start = deps.start ?? createAdbControl;
  const serialFor = deps.serialFor ?? getAdbSerialForDevice;
  const capture = deps.capture ?? captureDeviceScreenshot;
  const send = deps.fetch ?? fetch;
  const url = androidDeviceUrl(device);

  const queue: ControlRequest[] = [];
  const abort = new AbortController();
  // One device finger: a stable identity with a monotonic sequence across presses.
  const gesture = {
    id: `pane-${randomBytes(8).toString('hex')}`,
    epoch: 0,
    seq: 0,
    down: false,
  };
  let control: AdbServerInstance | undefined;
  let viewport = INITIAL_VIEWPORT;
  let cols = INITIAL_COLS;
  let rows = INITIAL_ROWS;
  let draining = false;
  let closed = false;
  let started = false;

  const deviceSize = () => control?.resolution() ?? { width: 1080, height: 2400 };

  /** An agent request: unlike user input it waits for the device and reports failure. */
  async function request(path: string, init?: RequestInit): Promise<Response> {
    await ready;
    const instance = control;
    if (closed || !instance) throw new Error('The Android viewer is closed');
    return send(new URL(path, instance.url), { ...init, signal: abort.signal });
  }

  const tools = createAndroidHttpTools(request, deviceSize);

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (!closed && queue.length) {
        const instance = control;
        if (!instance) {
          queue.length = 0;
          return;
        }
        const request = queue.shift();
        if (!request) return;
        try {
          await send(new URL(request.path, instance.url), {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(request.body),
            signal: abort.signal,
          });
        } catch {
          // Input is best effort; a failed event must not stall the ones behind it.
        }
      }
    } finally {
      draining = false;
    }
  }

  function enqueue(request: ControlRequest): void {
    if (closed) return;
    if (request.move) {
      const waiting = queue.findIndex((item) => item.move);
      if (waiting >= 0) {
        queue[waiting] = request;
        return;
      }
    }
    if (queue.length >= MAX_QUEUE) {
      const waitingMove = queue.findIndex((item) => item.move);
      if (waitingMove >= 0) queue.splice(waitingMove, 1);
      else if (request.release) queue.shift();
      else return;
    }
    queue.push(request);
    void drain();
  }

  function pointer(event: Extract<InputEvent, { kind: 'pointer' }>): void {
    // One device finger: the primary button drives it, other buttons are unsupported.
    if ((event.button ?? 'left') !== 'left') return;
    const size = deviceSize();
    const x = clamp((event.x / cols) * size.width, size.width - 1);
    const y = clamp((event.y / rows) * size.height, size.height - 1);
    if (event.action === 'up') {
      // Always lift: the registry releases held input on detach, so the tracking
      // state can be stale here and a missed lift would leave the finger down.
      gesture.seq += 1;
      gesture.down = false;
      enqueue({
        path: '/gesture',
        body: {
          phase: 'up',
          id: gesture.id,
          epoch: gesture.epoch,
          seq: gesture.seq,
          x,
          y,
        },
        release: true,
      });
      return;
    }
    if (event.action === 'down') {
      gesture.epoch += 1;
      gesture.seq += 1;
      gesture.down = true;
      enqueue({
        path: '/gesture',
        body: {
          phase: 'down',
          id: gesture.id,
          epoch: gesture.epoch,
          seq: gesture.seq,
          x,
          y,
        },
      });
      return;
    }
    if (!gesture.down) return;
    gesture.seq += 1;
    enqueue({
      path: '/gesture',
      body: {
        phase: 'move',
        id: gesture.id,
        epoch: gesture.epoch,
        seq: gesture.seq,
        x,
        y,
      },
      move: true,
    });
  }

  function key(event: Extract<InputEvent, { kind: 'key' }>): void {
    // Android key events are presses; a key up must not press again.
    if (event.up) return;
    const keycode = KEYCODES[event.key.toLowerCase().replaceAll('_', '')];
    if (keycode) enqueue({ path: '/key', body: { keycode } });
    else if (event.key.length === 1 && !event.modifiers?.some((m) => m !== 'shift'))
      text({ kind: 'text', text: event.key });
  }

  function text(event: Extract<InputEvent, { kind: 'text' }>): void {
    // `input text` types 1-256 printable ASCII; other text has no Android mapping.
    if (!event.text || event.text.length > MAX_TEXT) return;
    if (/[^\x20-\x7e]/.test(event.text)) return;
    enqueue({ path: '/text', body: { text: event.text } });
  }

  function input(event: InputEvent): void {
    if (closed) return;
    switch (event.kind) {
      case 'pointer':
        pointer(event);
        return;
      case 'key':
        key(event);
        return;
      case 'text':
        text(event);
        return;
      case 'wheel':
        // Wheel scrolling is unsupported: Android has no mouse wheel, and turning
        // it into a drag would steal the single finger from real gestures.
        return;
    }
  }

  function resize(next: Viewport): void {
    if (closed) return;
    if (Number.isInteger(next.cols) && next.cols > 0) cols = next.cols;
    if (Number.isInteger(next.rows) && next.rows > 0) rows = next.rows;
    viewport = { width: next.width, height: next.height };
    control?.resize(viewport);
  }

  function close(): void {
    if (closed) return;
    closed = true;
    queue.length = 0;
    abort.abort();
    const instance = control;
    control = undefined;
    instance?.stop();
  }

  const ready = (async () => {
    const serial = await serialFor(device);
    if (closed) return;
    const instance = await start(serial, {
      maxSize: 1080,
      viewport,
      onFrame: (data, width, height) => {
        if (closed) return;
        sink.submit({ surface: 'content', bitmap: data, width, height, x: 0, y: 0, z: 0 });
      },
    });
    if (closed) {
      instance.stop();
      return;
    }
    control = instance;
    started = true;
  })().catch((error: unknown) => {
    close();
    throw error;
  });

  return {
    ready,
    input,
    resize,
    status: async () => ({
      url,
      loading: !started && !closed,
      target: {
        kind: 'android',
        state: closed ? 'closed' : started ? 'ready' : 'starting',
        capabilities: { capture: true, tools: true, input: ['key', 'text', 'pointer'] },
      },
    }),
    callTool: async (name, params) => toJson(await tools.call(name, params)),
    listTools: () => toJson({ tools: tools.list() }),
    capture: async () => {
      const shot = await capture(device);
      if (!shot.ok || !shot.base64) {
        throw new Error(shot.error ?? 'Cannot capture the Android screen');
      }
      const size = deviceSize();
      return {
        png: Buffer.from(shot.base64, 'base64'),
        url,
        inputWidth: size.width,
        inputHeight: size.height,
      };
    },
    close,
  };
}
