export interface RegionBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function normalizeRegionBox(
  raw: unknown,
  bitmapWidth: number,
  bitmapHeight: number,
): RegionBox | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Region must be an object with x, y, width, height');
  }

  const obj = raw as Record<string, unknown>;
  const rawX = Number(obj.x);
  const rawY = Number(obj.y);
  const rawW = Number(obj.width);
  const rawH = Number(obj.height);

  if (
    !Number.isFinite(rawX) ||
    !Number.isFinite(rawY) ||
    !Number.isFinite(rawW) ||
    !Number.isFinite(rawH)
  ) {
    throw new Error('Region coordinates must be finite numbers');
  }

  let x = Math.round(rawX);
  let y = Math.round(rawY);
  let width = Math.round(rawW);
  let height = Math.round(rawH);

  // Normalize reversed drags
  if (width < 0) {
    x += width;
    width = -width;
  }
  if (height < 0) {
    y += height;
    height = -height;
  }

  if (width <= 0 || height <= 0) {
    throw new Error('Region width and height must be strictly positive');
  }

  if (x < 0 || y < 0 || x >= bitmapWidth || y >= bitmapHeight) {
    throw new Error(
      `Region start (${x}, ${y}) is outside bitmap bounds (${bitmapWidth}x${bitmapHeight})`,
    );
  }

  if (x + width > bitmapWidth || y + height > bitmapHeight) {
    throw new Error(
      `Region extent (${x + width}, ${y + height}) exceeds bitmap bounds (${bitmapWidth}x${bitmapHeight})`,
    );
  }

  return { x, y, width, height };
}
