import { describe, expect, test } from 'bun:test';
import { placePins, placeBubble } from './bubblePlacement';

const viewport = { width: 1000, height: 600 };
const size = { width: 260, height: 120 };

describe('placeBubble', () => {
  test('prefers below the target, left edges aligned', () => {
    const p = placeBubble({ x: 100, y: 100, width: 80, height: 40 }, size, viewport);
    expect(p).toEqual({ x: 100, y: 148, side: 'below' });
  });

  test('flips above when there is no room below', () => {
    const p = placeBubble({ x: 100, y: 500, width: 80, height: 40 }, size, viewport);
    expect(p.side).toBe('above');
    expect(p.y).toBe(500 - 120 - 8);
  });

  test('goes beside the target when it is tall and full width above/below fails', () => {
    const p = placeBubble({ x: 100, y: 10, width: 80, height: 580 }, size, viewport);
    expect(p.side).toBe('right');
    expect(p.x).toBe(188);
  });

  test('clamps to the viewport on the cross axis', () => {
    const p = placeBubble({ x: 900, y: 100, width: 80, height: 40 }, size, viewport);
    expect(p.x).toBe(1000 - 260 - 8);
  });

  test('never leaves the viewport even when the target covers it', () => {
    const p = placeBubble({ x: 0, y: 0, width: 1000, height: 600 }, size, viewport);
    expect(p.side).toBe('inside');
    expect(p.x).toBeGreaterThanOrEqual(8);
    expect(p.y).toBeGreaterThanOrEqual(8);
    expect(p.x + size.width).toBeLessThanOrEqual(992);
    expect(p.y + size.height).toBeLessThanOrEqual(592);
  });

  test('does not overlap the target whenever a free side exists', () => {
    for (const t of [
      { x: 10, y: 10, width: 50, height: 50 },
      { x: 940, y: 540, width: 50, height: 50 },
      { x: 500, y: 300, width: 100, height: 100 },
    ]) {
      const p = placeBubble(t, size, viewport);
      const overlaps =
        p.x < t.x + t.width && p.x + size.width > t.x && p.y < t.y + t.height && p.y + size.height > t.y;
      expect(overlaps).toBe(false);
    }
  });

  test('shrinks into a small viewport instead of going negative', () => {
    const p = placeBubble({ x: 10, y: 10, width: 20, height: 20 }, size, { width: 200, height: 100 });
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
  });
});

describe('placePins', () => {
  const viewport = { width: 300, height: 200 };
  function check(xs: number[], y = 80) {
    const pins = placePins(xs.map((x) => ({ x, y, width: 10, height: 10 })), viewport);
    pins.forEach((p, i) => {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x + 32).toBeLessThanOrEqual(viewport.width);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y + 20).toBeLessThanOrEqual(viewport.height);
      pins.slice(0, i).forEach((q) => {
        expect(p.x >= q.x + 32 || q.x >= p.x + 32 || p.y >= q.y + 20 || q.y >= p.y + 20).toBe(true);
      });
    });
  }
  test('checks shifted positions, not just original corners', () => check([100, 70, 101, 129]));
  test('wraps nearby pins at the right edge', () => check([290, 290, 290, 290]));
  test('keeps top-edge pins visible', () => check([0, 0, 0], 0));
  test('keeps pins outside the open bubble', () => {
    const bubble = { x: 80, y: 60, width: 180, height: 100 };
    const pins = placePins([{ x: 100, y: 100, width: 10, height: 10 }], viewport, [bubble]);
    expect(pins).toHaveLength(1);
    const pin = pins[0];
    expect(pin.x + 32 <= bubble.x || pin.x >= bubble.x + bubble.width || pin.y + 20 <= bubble.y || pin.y >= bubble.y + bubble.height).toBe(true);
  });
});
