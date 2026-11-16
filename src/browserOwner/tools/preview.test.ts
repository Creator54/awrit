import { expect, test } from 'bun:test';
import type { WebContents } from 'electron';
import {
  devicePointOnPage,
  withoutAgentPreview,
  markAgentActivity,
  showActionPreview,
  showAreaPreview,
  showDevicePreview,
  showUserInControl,
} from './preview';

test('a device preview maps device pixels onto the #screen frame', async () => {
  const scripts: string[] = [];
  const wc = {
    executeJavaScript: async (code: string) => {
      scripts.push(code);
      if (code.includes("getElementById('screen')")) {
        return { x: 0, y: 50, width: 1000, height: 1000, naturalWidth: 1080, naturalHeight: 1920 };
      }
      return undefined;
    },
    on: () => wc,
  } as unknown as WebContents;
  // Screen centre 540x960 -> frame centre 500x550.
  await showDevicePreview(wc, { x: 540, y: 960 }, { width: 1080, height: 1920 }, 'tap', false, 1);
  const overlay = sansEdge(scripts).find((c) => c.includes('attachShadow'));
  expect(overlay).toContain('translate3d(500px, 550px, 0)');
  expect(overlay).toContain('"tap"');
});

test('a device preview is a no-op when the screen frame is missing or empty', async () => {
  for (const box of [null, { x: 0, y: 0, width: 0, height: 0, naturalWidth: 1080, naturalHeight: 1920 }]) {
    const { wc, scripts } = fakePage();
    const wcWithBox = {
      executeJavaScript: async (code: string) =>
        code.includes("getElementById('screen')") ? box : undefined,
      on: () => wcWithBox,
    } as unknown as WebContents;
    await showDevicePreview(wcWithBox, { x: 540, y: 960 }, { width: 1080, height: 1920 }, 'tap', false, 1);
    expect(sansEdge(scripts)).toEqual([]);
  }
});

test('device pixels map onto the letterboxed frame (pure function)', () => {
  const device = { width: 1080, height: 1920 };
  // A 1000x1000 box holds the 9:16 frame 562.5 wide, centred: 218.75px bars left and right.
  const box = { x: 0, y: 50, width: 1000, height: 1000, naturalWidth: 1080, naturalHeight: 1920 };
  expect(devicePointOnPage({ x: 0, y: 0 }, box, device)).toEqual({ x: 219, y: 50 });
  expect(devicePointOnPage({ x: 540, y: 960 }, box, device)).toEqual({ x: 500, y: 550 });
  expect(devicePointOnPage({ x: 1080, y: 1920 }, box, device)).toEqual({ x: 781, y: 1050 });
});

function fakePage() {
  const scripts: string[] = [];
  const wc = {
    executeJavaScript: async (code: string) => {
      scripts.push(code);
    },
    on: () => wc,
  } as unknown as WebContents;
  return { wc, scripts };
}

/** The presence edge script accompanies every call; tests assert on the overlay itself. */
const sansEdge = (scripts: string[]) => scripts.filter((c) => !c.includes("getElementById('edge')"));

test('the cursor starts at the first target and moves from the last point next time', async () => {
  const { wc, scripts } = fakePage();
  await showActionPreview(wc, { x: 10, y: 20, label: 'click' }, 1);
  expect(sansEdge(scripts)[0]).toContain('__awrit_agent_overlay');
  expect(sansEdge(scripts)[0]).toContain('attachShadow');
  expect(sansEdge(scripts)[0]).toContain('translate3d(10px, 20px, 0)');

  await showActionPreview(wc, { x: 50, y: 60, label: 'type' }, 1);
  expect(sansEdge(scripts)[1]).toContain('translate3d(10px, 20px, 0)');
  expect(sansEdge(scripts)[1]).toContain('translate3d(50px, 60px, 0)');
  expect(sansEdge(scripts)[1]).toContain('"type"');
});

test('a click asks for the press pulse and no call removes the cursor', async () => {
  const { wc, scripts } = fakePage();
  await showActionPreview(wc, { x: 1, y: 2, label: 'click', press: true }, 1);
  expect(sansEdge(scripts)[1]).toContain("add('pressed')");
  expect(scripts.some((c) => c.startsWith('document.getElementById'))).toBe(false);
});

test('no preview time skips the cursor but still marks presence', async () => {
  for (const ms of [0, -1]) {
    const { wc, scripts } = fakePage();
    await showActionPreview(wc, { x: 1, y: 2, label: 'click' }, ms);
    expect(sansEdge(scripts)).toEqual([]);
  }
});

test('the area block is fire-and-forget', async () => {
  const { wc, scripts } = fakePage();
  const started = Date.now();
  await showAreaPreview(wc, 'viewport', 'reading page text');
  expect(Date.now() - started).toBeLessThan(50);
  expect(sansEdge(scripts)[0]).toContain("root.getElementById('area')");
  expect(sansEdge(scripts)[0]).toContain('window.innerWidth');
  expect(sansEdge(scripts)[0]).toContain('"reading page text"');

  await showAreaPreview(wc, { x: 4, y: 5, width: 6, height: 7 }, 'typing');
  expect(sansEdge(scripts)[1]).toContain('{"x":4,"y":5,"width":6,"height":7}');
});

test('captures hide the cursor and show it again where the agent left it', async () => {
  const { wc, scripts } = fakePage();
  await showActionPreview(wc, { x: 40, y: 50, label: 'click' }, 1);
  const before = scripts.length;
  const order: string[] = [];
  const result = await withoutAgentPreview(wc, async () => {
    order.push(`capture after ${scripts.length - before} scripts`);
    return 'png';
  });
  expect(result).toBe('png');
  expect(order).toEqual(['capture after 1 scripts']);
  expect(scripts[before]).toContain("visibility = 'hidden'");
  expect(scripts[before + 1]).toContain("removeProperty('visibility')");
  await showActionPreview(wc, { x: 60, y: 70, label: 'click' }, 1);
  expect(sansEdge(scripts.slice(before + 2)).join('')).toContain('translate3d(40px, 50px, 0)');
});

test('the cursor comes back even when the capture fails', async () => {
  const { wc, scripts } = fakePage();
  await expect(
    withoutAgentPreview(wc, async () => {
      throw new Error('capture failed');
    }),
  ).rejects.toThrow('capture failed');
  expect(scripts.at(-1)).toContain("removeProperty('visibility')");
});

test('preview failures never throw', async () => {
  const wc = {
    executeJavaScript: async () => {
      throw new Error('page gone');
    },
  } as unknown as WebContents;
  await showActionPreview(wc, { x: 1, y: 2, label: 'click' }, 1);
  await showAreaPreview(wc, 'viewport', 'reading page');
  expect(await withoutAgentPreview(wc, async () => 'png')).toBe('png');
});

test('the cursor stays where it was after navigation and carries the agent name', async () => {
  const { performNavigate } = await import('./navigate');
  const { wc, scripts } = fakePage();
  Object.assign(wc, {
    loadURL: async () => {},
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
    on: () => wc,
  });
  markAgentActivity(wc, 'Claude');
  await showActionPreview(wc, { x: 10, y: 20, label: 'click' }, 1);
  expect((await performNavigate(wc, { url: 'https://example.com/' }, 1, 0)).ok).toBe(true);
  const last = scripts[scripts.length - 1];
  expect(last).toContain('translate3d(10px, 20px, 0)');
  expect(last).toContain('"Claude"');
});

test('navigate shows the address it opens before loading it', async () => {
  const { performNavigate } = await import('./navigate');
  const { wc, scripts } = fakePage();
  const order: string[] = [];
  Object.assign(wc, {
    loadURL: async () => { order.push('load'); },
    getURL: () => 'https://example.com/',
    getTitle: () => 'Example',
    on: () => wc,
  });
  const run = wc.executeJavaScript;
  wc.executeJavaScript = async (code: string, flag?: boolean) => {
    if (code.includes("getElementById('urlpill')")) order.push('pill');
    return run(code, flag);
  };
  await performNavigate(wc, { url: 'https://example.com/' }, 1, 1);
  expect(order).toEqual(['pill', 'load']);
  expect(scripts.some((c) => c.includes('https://example.com/'))).toBe(true);
});

test('every preview call refreshes the presence edge', async () => {
  const { wc, scripts } = fakePage();
  await showAreaPreview(wc, 'viewport');
  expect(scripts.some((c) => c.includes("getElementById('edge')"))).toBe(true);
  expect(scripts[0]).toContain('60000');
});

test('typed text is shown in the chip but never for passwords', async () => {
  const { performType } = await import('./type');
  for (const [secret, shown] of [[false, 'type \\"hello\\"'], [true, 'type \\"••••\\"']] as const) {
    const { wc, scripts } = fakePage();
    Object.assign(wc, {
      executeJavaScript: async (code: string) => {
        scripts.push(code);
        return code.includes('select()') ? { ok: true, x: 5, y: 6, secret } : undefined;
      },
      insertText: async () => {},
    });
    await performType(wc, { text: 'hello', selector: '#f', previewMs: 1 });
    expect(scripts.some((c) => c.includes(shown))).toBe(true);
    expect(scripts.some((c) => c.includes('hello') && secret)).toBe(false);
  }
});

test('the cursor says the agent left when its lease runs out', async () => {
  const { wc, scripts } = fakePage();
  Object.assign(wc, { on: () => wc });
  markAgentActivity(wc, 'Claude');
  const original = performance.now;
  performance.now = () => original.call(performance) + 120_000;
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const { announceDeparture } = await import('./preview');
    announceDeparture(wc);
  } finally {
    performance.now = original;
  }
  expect(scripts[scripts.length - 1]).toContain('Claude left');
});

test('the first call says the agent took over, later calls only show its name', () => {
  const { wc, scripts } = fakePage();
  markAgentActivity(wc, 'Claude');
  markAgentActivity(wc);
  const cursors = scripts.filter((c) => c.includes("getElementById('cursor')"));
  expect(cursors[0]).toContain('"Claude took over"');
  expect(cursors[1]).toContain('"Claude"');
});

test('shows that the user is in control only while an agent is present', () => {
  const { wc, scripts } = fakePage();
  showUserInControl(wc);
  expect(scripts).toHaveLength(0);
  markAgentActivity(wc, 'Claude');
  showUserInControl(wc);
  expect(scripts[scripts.length - 1]).toContain('in control');
});
