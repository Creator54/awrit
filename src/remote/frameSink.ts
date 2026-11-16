import { frameTrace } from '../frameTrace';
import { encodePng } from './png';
import { LIMITS, type MediaFrame, type Surface } from './protocol';

/** Initial scheduling ceiling: at most one send per surface per 33 ms. */
const MIN_SEND_INTERVAL_MS = 33;

export interface FrameSinkClock {
  now(): number;
  /** Runs `run` after `delayMs`; returns a cancel function. */
  setTimer(delayMs: number, run: () => void): () => void;
}

/** Default clock for the frame sink and the owner's heartbeat/grace timers. */
export const systemClock: FrameSinkClock = {
  now: () => performance.now(),
  setTimer(delayMs, run) {
    const timer = setTimeout(run, Math.ceil(delayMs));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

export interface EncodeInput {
  /** BGRA bitmap; the encoder must copy before transferring it. */
  bitmap: Uint8Array;
  width: number;
  height: number;
}

export type FrameEncoder = (input: EncodeInput) => Promise<Buffer>;

/** In-process encoder. Packaging has no bundled worker entry yet. */
const defaultEncoder: FrameEncoder = async ({ bitmap, width, height }) =>
  encodePng(bitmap, width, height);

export interface FrameSubmit {
  surface: Surface;
  /** BGRA bytes, `width * height * 4` long. */
  bitmap: Uint8Array;
  width: number;
  height: number;
  /** Destination geometry in device pixels. */
  x: number;
  y: number;
  z: number;
}

export interface FrameSinkOptions {
  session: string;
  /** Media generation, bumped when a controller reattaches. */
  generation?: number;
  clock?: FrameSinkClock;
  /** Defaults to an in-process `encodePng`. */
  encode?: FrameEncoder;
  /** Cover/uncover is a control message, not a frame. */
  cover?: (surface: Surface, covered: boolean) => void;
  onError?: (error: unknown) => void;
}

export interface FrameSink {
  /** Replaces any unsent frame for the surface; never detaches the bitmap. */
  submit(frame: FrameSubmit): void;
  /** The client has a free decode slot for this surface again. */
  grant(surface: Surface): void;
  /** Drops pending frames when the viewport epoch changes. */
  setEpoch(epoch: number): void;
  cover(surface: Surface, covered: boolean): void;
  dispose(): void;
}

interface SurfaceState {
  pending?: FrameSubmit;
  /** Media credit, capped at one transmitted-but-unacknowledged frame. */
  credit: 0 | 1;
  busy: boolean;
  covered: boolean;
  lastSend: number;
  cancelTimer?: () => void;
}

function createSurfaceState(): SurfaceState {
  return { credit: 1, busy: false, covered: false, lastSend: Number.NEGATIVE_INFINITY };
}

/**
 * Server-side frame sink: keeps the newest frame per surface, encodes it, and
 * sends at most one unacknowledged frame per surface.
 */
export function createFrameSink(
  send: (frame: MediaFrame) => void,
  options: FrameSinkOptions,
): FrameSink {
  const { session, cover } = options;
  const generation = options.generation ?? 0;
  const clock = options.clock ?? systemClock;
  const encode = options.encode ?? defaultEncoder;
  const surfaces: Record<Surface, SurfaceState> = {
    content: createSurfaceState(),
    toolbar: createSurfaceState(),
  };
  const report = (error: unknown) => {
    if (options.onError) options.onError(error);
    else console.error('Frame sink:', error);
  };

  let epoch = 0;
  let frame = 0;
  let disposed = false;

  const pump = (surface: Surface): void => {
    const state = surfaces[surface];
    if (disposed || state.busy || state.credit < 1 || state.covered || !state.pending) return;

    const wait = MIN_SEND_INTERVAL_MS - (clock.now() - state.lastSend);
    if (wait > 0) {
      if (state.cancelTimer) return;
      state.cancelTimer = clock.setTimer(wait, () => {
        state.cancelTimer = undefined;
        pump(surface);
      });
      return;
    }

    const next = state.pending;
    state.pending = undefined;
    state.busy = true;
    state.credit = 0;
    const encodingEpoch = epoch;
    const encodingStarted = frameTrace.enabled ? frameTrace.now() : 0;
    encode({ bitmap: next.bitmap, width: next.width, height: next.height }).then(
      (payload) => {
        if (frameTrace.enabled) frameTrace.encoded(surface, encodingStarted);
        state.busy = false;
        if (disposed) return;
        if (encodingEpoch !== epoch) {
          // The viewport changed while encoding; the result is stale.
          state.credit = 1;
          pump(surface);
          return;
        }
        if (state.covered) {
          // Cover went out while encoding; do not paint content after it.
          state.credit = 1;
          return;
        }
        state.lastSend = clock.now();
        state.credit = 0;
        try {
          send({
            meta: {
              session,
              surface,
              generation,
              epoch,
              frame: ++frame,
              codec: 'png',
              width: next.width,
              height: next.height,
              x: next.x,
              y: next.y,
              z: next.z,
            },
            payload,
          });
        } catch (error) {
          report(error);
        }
        pump(surface);
      },
      (error) => {
        state.busy = false;
        if (disposed) return;
        state.credit = 1;
        report(error);
      },
    );
  };

  return {
    submit(frame) {
      if (disposed) return;
      if (
        !Number.isSafeInteger(frame.width) ||
        !Number.isSafeInteger(frame.height) ||
        frame.width < 1 ||
        frame.height < 1 ||
        frame.width > LIMITS.maxSide ||
        frame.height > LIMITS.maxSide ||
        frame.width * frame.height > LIMITS.maxPixels ||
        frame.bitmap.byteLength !== frame.width * frame.height * 4 ||
        !Number.isSafeInteger(frame.x) ||
        !Number.isSafeInteger(frame.y) ||
        !Number.isSafeInteger(frame.z) ||
        frame.x < 0 ||
        frame.y < 0 ||
        frame.z < 0
      )
        throw new Error('Invalid frame');
      const state = surfaces[frame.surface];
      state.pending = frame;
      pump(frame.surface);
    },
    grant(surface) {
      if (disposed) return;
      const state = surfaces[surface];
      state.credit = 1;
      pump(surface);
    },
    setEpoch(next) {
      if (disposed || next === epoch) return;
      if (!Number.isSafeInteger(next) || next < 0) throw new Error('Invalid epoch');
      epoch = next;
      for (const state of Object.values(surfaces)) state.pending = undefined;
    },
    cover(surface, covered) {
      if (disposed) return;
      const state = surfaces[surface];
      state.covered = covered;
      if (covered) state.pending = undefined;
      else pump(surface);
      cover?.(surface, covered);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const state of Object.values(surfaces)) {
        state.pending = undefined;
        state.cancelTimer?.();
        state.cancelTimer = undefined;
      }
    },
  };
}
