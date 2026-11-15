import type { WebContents } from 'electron';
import { showUserInControl } from './preview';
import { waitForUserIdle } from './userActivity';
import type { ToolDefinition, ToolRegistry } from './registry';

export interface DocumentId {
  frameUrl: string;
  navId: number;
}

export interface PaneBinding {
  currentDocument: DocumentId;
  clientSocket: NodeJS.Socket;
  webContents: WebContents;
}

interface QueueEntry {
  resolve: (result: unknown) => void;
  name: string;
  input: unknown;
  webContents: WebContents;
  clientSocket: NodeJS.Socket;
  expectedDoc: DocumentId;
  deadline: number;
  isObservation: boolean;
  aborted?: boolean;
}

interface DocLane {
  running: boolean;
  queue: QueueEntry[];
  abortSignal?: AbortSignal;
}

export interface ToolDispatcher {
  updatePaneBinding(paneId: string, binding: PaneBinding): void;
  call(
    paneId: string,
    name: string,
    input: unknown,
    expectedDoc: DocumentId,
    timeoutMs: number,
  ): Promise<unknown>;
  disconnectSocket(socket: NodeJS.Socket): void;
  invalidateDocument(doc: DocumentId): void;
}

export function createDispatcher(registry: ToolRegistry): ToolDispatcher {
  const paneBindings = new Map<string, PaneBinding>();
  const docLanes = new Map<string, DocLane>();

  const docKey = (doc: DocumentId) => `${doc.frameUrl}#${doc.navId}`;

  const processQueue = async (key: string) => {
    const lane = docLanes.get(key);
    if (!lane || lane.running || lane.queue.length === 0) return;

    lane.running = true;
    const entry = lane.queue.shift();
    if (!entry) {
      lane.running = false;
      return;
    }

    (async () => {
      try {
        const def = registry.get(entry.name);
        const now = Date.now();
        const timeLeft = entry.deadline - now;

        if (timeLeft <= 0) {
          entry.resolve({ ok: false, outcome: entry.isObservation ? 'observation-timeout' : 'unknown' });
          return;
        }

        if (!entry.isObservation && !(await waitForUserIdle(() => showUserInControl(entry.webContents)))) {
          entry.resolve({ ok: false, error: 'The user is using the page right now. Try again in a moment.' });
          return;
        }

        const resultPromise = Promise.resolve().then(() =>
          def.handler(entry.input, { webContents: entry.webContents }),
        );
        let settled = false;

        const timeout = new Promise<never>((_, reject) =>
          setTimeout(
            () =>
              reject(
                new Error(entry.isObservation ? 'observation-timeout' : 'unknown'),
              ),
            timeLeft,
          ),
        );

        try {
          const result = await Promise.race([resultPromise, timeout]);
          if (!settled) {
            settled = true;
            // Tools report their own failures as { ok: false, error }; pass those through.
            const failed =
              typeof result === 'object' && result !== null && Reflect.get(result, 'ok') === false;
            entry.resolve(failed ? result : { ok: true, result });
          }
        } catch (err) {
          if (!settled) {
            settled = true;
            const msg = err instanceof Error ? err.message : String(err);
            if (msg === 'observation-timeout' || msg === 'unknown') {
              entry.resolve({ ok: false, outcome: msg as 'observation-timeout' | 'unknown' });
            } else {
              entry.resolve({ ok: false, error: msg });
            }
          }
        }

        // Wait for actual handler settlement even after timeout
        await resultPromise.catch(() => {});
      } finally {
        lane.running = false;
        processQueue(key);
      }
    })();
  };

  return {
    updatePaneBinding(paneId: string, binding: PaneBinding) {
      paneBindings.set(paneId, binding);
    },

    async call(paneId: string, name: string, input: unknown, expectedDoc: DocumentId, timeoutMs: number) {
      let def: ToolDefinition;
      try {
        def = registry.get(name);
        await registry.validate(name, input);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      const binding = paneBindings.get(paneId);
      if (!binding) {
        return { ok: false, outcome: 'not-started' };
      }

      // Check current document matches expected (no await between here and the enqueue, so navigation cannot slip in)
      const current = binding.currentDocument;
      if (current.navId !== expectedDoc.navId || current.frameUrl !== expectedDoc.frameUrl) {
        return { ok: false, outcome: 'not-started' };
      }

      const key = docKey(expectedDoc);

      let lane = docLanes.get(key);
      if (!lane) {
        lane = { running: false, queue: [] };
        docLanes.set(key, lane);
      }

      // Queue capacity: 1 running + 8 queued max
      if (lane.running && lane.queue.length >= 8) {
        return { ok: false, outcome: 'not-started' };
      }
      if (!lane.running && lane.queue.length >= 8) {
        return { ok: false, outcome: 'not-started' };
      }

      return new Promise((resolve) => {
        const entry: QueueEntry = {
          resolve,
          name,
          input,
          webContents: binding.webContents,
          clientSocket: binding.clientSocket,
          expectedDoc,
          deadline: Date.now() + Math.min(timeoutMs, def.timeoutMs),
          isObservation: def.effect === 'observation',
        };

        lane.queue.push(entry);
        processQueue(key);
      });
    },

    disconnectSocket(socket: NodeJS.Socket) {
      // Abort only this client's queued calls; other clients' calls on the same page stay.
      for (const [key, lane] of docLanes) {
        const kept = [];
        for (const entry of lane.queue) {
          if (entry.clientSocket === socket) {
            entry.resolve({ ok: false, outcome: 'not-started' });
          } else kept.push(entry);
        }
        lane.queue = kept;
        if (!lane.running && lane.queue.length === 0) docLanes.delete(key);
      }
      for (const [paneId, binding] of paneBindings) {
        if (binding.clientSocket === socket) paneBindings.delete(paneId);
      }
    },

    invalidateDocument(doc: DocumentId) {
      const key = docKey(doc);
      const lane = docLanes.get(key);
      if (lane) {
        for (const entry of lane.queue) {
          entry.resolve({ ok: false, outcome: 'not-started' });
        }
        lane.queue = [];
      }
    },
  };
}
