import { randomUUID } from 'node:crypto';
import type { InputEvent, Modifier, PointerButton } from './protocol';

/** The minimal pane a session owns; the owner connection provides the real one. */
export interface SessionPane {
  input(event: InputEvent): void;
  close(): void;
}

export interface SessionRegistryDeps {
  /** The id is passed in so a pane can tag its output (for example a frame sink). */
  createPane: (url: string, id: string) => SessionPane;
  now: () => number;
}

interface Session {
  id: string;
  url: string;
  pane: SessionPane;
  createdAt: number;
  generation: number;
  controller?: { id: string; generation: number };
  seq: number;
  /** Keys the controller is holding down, by key code, with their modifiers. */
  heldKeys: Map<string, Modifier[]>;
  /** Pointer buttons held down, with the last pointer position. */
  heldButtons: Map<PointerButton, { x: number; y: number }>;
  pointer: { x: number; y: number };
}

/** `busy` means another controller holds the lease; it is never taken over. */
export type AttachResult = number | 'busy';

/**
 * Server-side session registry. Pure: panes and the clock are injected. It tracks
 * what the controller is holding down so a lost connection can release it; the
 * owner runs the heartbeat and detach grace timers that call `release`/`detach`.
 */
export function createSessionRegistry(deps: SessionRegistryDeps) {
  const sessions = new Map<string, Session>();

  const session = (sessionId: string): Session => {
    const found = sessions.get(sessionId);
    if (!found) throw new Error(`Unknown session ${sessionId}`);
    return found;
  };

  function create(url: string): string {
    // Detached panes still own browser resources until stop or grace expiry.
    if (sessions.size >= 32) throw new Error('Remote session limit reached');
    const id = randomUUID();
    sessions.set(id, {
      id,
      url,
      pane: deps.createPane(url, id),
      createdAt: deps.now(),
      generation: 0,
      seq: -1,
      heldKeys: new Map(),
      heldButtons: new Map(),
      pointer: { x: 0, y: 0 },
    });
    return id;
  }

  function attach(sessionId: string, controllerId: string): AttachResult {
    const target = session(sessionId);
    if (target.controller) return 'busy';
    target.generation += 1;
    target.controller = { id: controllerId, generation: target.generation };
    target.seq = -1;
    return target.generation;
  }

  function detach(sessionId: string): void {
    session(sessionId).controller = undefined;
  }

  function stop(sessionId: string): void {
    const target = session(sessionId);
    sessions.delete(sessionId);
    target.pane.close();
  }

  /** Remembers press/release state so a lost controller cannot leave input stuck. */
  function track(target: Session, event: InputEvent): void {
    if (event.kind === 'key') {
      if (event.up) target.heldKeys.delete(event.key);
      else target.heldKeys.set(event.key, event.modifiers ?? []);
      return;
    }
    if (event.kind === 'pointer') {
      target.pointer = { x: event.x, y: event.y };
      if (event.action === 'down' && event.button)
        target.heldButtons.set(event.button, target.pointer);
      if (event.action === 'up' && event.button) target.heldButtons.delete(event.button);
      return;
    }
    if (event.kind === 'wheel') target.pointer = { x: event.x, y: event.y };
  }

  function handleInput(
    sessionId: string,
    generation: number,
    seq: number,
    event: InputEvent,
  ): boolean {
    const target = session(sessionId);
    if (!target.controller || target.controller.generation !== generation) return false;
    if (seq <= target.seq) return false;
    target.seq = seq;
    track(target, event);
    target.pane.input(event);
    return true;
  }

  /**
   * Sends synthetic releases for everything still held and clears them. Returns
   * how many inputs were released, so the caller can log one line per loss.
   */
  function release(sessionId: string): number {
    const target = session(sessionId);
    const { heldKeys, heldButtons, pane, pointer } = target;
    let released = 0;
    for (const [key, modifiers] of heldKeys) {
      pane.input({
        kind: 'key',
        key,
        ...(modifiers.length ? { modifiers } : {}),
        up: true,
      });
      released += 1;
    }
    for (const button of heldButtons.keys()) {
      pane.input({ kind: 'pointer', action: 'up', x: pointer.x, y: pointer.y, button });
      released += 1;
    }
    heldKeys.clear();
    heldButtons.clear();
    return released;
  }

  return { create, attach, detach, stop, handleInput, release };
}
