import type { ShmGraphicBuffer, SupportedFeatures, WindowSize } from 'awrit-native-rs';
import type { PaneSettings } from '../browserOwner/options';
import { createTerminalGraphics } from '../tty/kittyGraphics';
import { createTerminalOutput } from '../tty/output';
import { frameTrace } from '../frameTrace';

/** Explicit terminal resources retained by each view and asynchronous callback. */
export function createTerminalContext(
  id: string,
  size: WindowSize,
  features: SupportedFeatures,
  sink: (data: string) => unknown,
  settings: PaneSettings,
  identity: { sourceWindowId?: string; kittyWindowId?: string; terminalScheme?: 'light' | 'dark'; terminalBackground?: string } = {},
) {
  const output = createTerminalOutput(sink);
  const pending = new Map<number, ShmGraphicBuffer[]>();
  const emittedAt = new Map<number, number[]>();
  let pendingCount = 0;
  let disposed = false;
  return {
    id,
    identity,
    actions: undefined as
      | {
          newWindow: (url?: string) => void;
          cycle: (step?: number) => boolean;
          select: (index: number) => boolean;
          list: () => Array<{ id?: number; title: string; url: string; current: boolean; thumbnail?: string }>;
          closeTab: () => boolean;
          closeTabAt: (index: number) => boolean;
          close: () => void;
        }
      | undefined,
    size,
    features,
    settings,
    output,
    graphics: createTerminalGraphics(output, (image, buffer) => {
      const queue = pending.get(image) ?? [];
      queue.push(buffer);
      pending.set(image, queue);
      pendingCount++;
      if (frameTrace.enabled) {
        const times = emittedAt.get(image) ?? [];
        times.push(frameTrace.now());
        emittedAt.set(image, times);
      }
    }),
    canPaint: () => !disposed && pendingCount < 4,
    acknowledgeGraphics(control: string) {
      const match = /(?:^|,)i=(\d+)(?:,|$)/.exec(control);
      if (!match) return;
      const image = Number(match[1]);
      const queue = pending.get(image);
      if (queue?.length) {
        queue.shift();
        pendingCount--;
        if (frameTrace.enabled) {
          const times = emittedAt.get(image);
          const startedAt = times?.shift();
          if (startedAt !== undefined) frameTrace.record('ack', startedAt);
          if (!times?.length) emittedAt.delete(image);
        }
      }
      if (!queue?.length) pending.delete(image);
    },
    dispose() {
      disposed = true;
      pending.clear();
      emittedAt.clear();
      pendingCount = 0;
    },
  };
}
export type TerminalContext = ReturnType<typeof createTerminalContext>;
