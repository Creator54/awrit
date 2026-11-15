export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface Size {
  width: number;
  height: number;
}
export type BubbleSide = 'below' | 'above' | 'right' | 'left' | 'inside';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

/**
 * Places a note bubble beside the selection without covering it: below, above,
 * right, then left; if the selection fills the view, inside its bottom edge.
 * The result always stays within the viewport.
 */
export function placeBubble(
  target: Box,
  size: Size,
  viewport: Size,
  gap = 8,
  margin = 8,
): { x: number; y: number; side: BubbleSide } {
  const maxX = Math.max(margin, viewport.width - size.width - margin);
  const maxY = Math.max(margin, viewport.height - size.height - margin);
  const alignX = clamp(target.x, margin, maxX);
  const alignY = clamp(target.y, margin, maxY);

  const below = target.y + target.height + gap;
  if (below <= maxY) return { x: alignX, y: below, side: 'below' };
  const above = target.y - size.height - gap;
  if (above >= margin) return { x: alignX, y: above, side: 'above' };
  const right = target.x + target.width + gap;
  if (right <= maxX) return { x: right, y: alignY, side: 'right' };
  const left = target.x - size.width - gap;
  if (left >= margin) return { x: left, y: alignY, side: 'left' };
  return { x: alignX, y: clamp(target.y + target.height - size.height - gap, margin, maxY), side: 'inside' };
}

export const PIN_WIDTH = 32;
export const PIN_HEIGHT = 20;

/** Place compact pins against already placed rectangles, wrapping at the edge. */
export function placePins(boxes: Box[], viewport: Size, obstacles: Box[] = []): { x: number; y: number }[] {
  const placed: { x: number; y: number }[] = [];
  const maxX = Math.max(0, viewport.width - PIN_WIDTH);
  const maxY = Math.max(0, viewport.height - PIN_HEIGHT);
  for (const box of boxes) {
    const origin = { x: clamp(box.x, 0, maxX), y: clamp(box.y - PIN_HEIGHT, 0, maxY) };
    let position = origin;
    let found = false;
    // Search from the anchor, then wrap across the viewport in compact rows.
    const xs = Array.from({ length: Math.ceil(maxX / PIN_WIDTH) + 1 }, (_, i) => Math.min(i * PIN_WIDTH, maxX));
    const ys = Array.from({ length: Math.ceil(maxY / PIN_HEIGHT) + 1 }, (_, i) => Math.min(i * PIN_HEIGHT, maxY));
    xs.push(origin.x);
    ys.push(origin.y);
    xs.sort((a, b) => Math.abs(a - origin.x) - Math.abs(b - origin.x));
    ys.sort((a, b) => Math.abs(a - origin.y) - Math.abs(b - origin.y));
    for (const y of ys) {
      for (const x of xs) {
        const clearsBubble = obstacles.every((p) => x >= p.x + p.width || p.x >= x + PIN_WIDTH || y >= p.y + p.height || p.y >= y + PIN_HEIGHT);
        if (clearsBubble && placed.every((p) => x >= p.x + PIN_WIDTH || p.x >= x + PIN_WIDTH || y >= p.y + PIN_HEIGHT || p.y >= y + PIN_HEIGHT)) {
          position = { x, y };
          found = true;
          break;
        }
      }
      if (found) break;
    }
    // shortcut: a viewport completely filled with pins must reuse an anchor.
    placed.push(position);
  }
  return placed;
}
