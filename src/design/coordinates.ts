import {
  type RegionBox,
  normalizeRegionBox,
} from './regionBox';
import type {
  Dimensions,
  ImageTransform,
  Point,
  ViewportGeometry,
} from './types';

export function normalizePixelRegion(
  raw: { x: number; y: number; width: number; height: number },
  bitmapWidth: number,
  bitmapHeight: number,
): RegionBox {
  const normalized = normalizeRegionBox(raw, bitmapWidth, bitmapHeight);
  if (!normalized) {
    throw new Error('Region coordinates required');
  }
  return normalized;
}

export function computeContainedImageBounds(
  viewport: ViewportGeometry,
  screenshot: Dimensions,
): RegionBox {
  if (
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    throw new Error('Viewport dimensions must be finite and positive');
  }
  if (
    !Number.isFinite(screenshot.width) ||
    !Number.isFinite(screenshot.height) ||
    screenshot.width <= 0 ||
    screenshot.height <= 0
  ) {
    throw new Error('Screenshot dimensions must be finite and positive');
  }

  const viewportRatio = viewport.width / viewport.height;
  const imageRatio = screenshot.width / screenshot.height;

  let renderW = viewport.width;
  let renderH = viewport.height;
  let offsetX = 0;
  let offsetY = 0;

  if (viewportRatio > imageRatio) {
    // Viewport is wider than image: pillarbox (black bars on left & right)
    renderW = viewport.height * imageRatio;
    offsetX = (viewport.width - renderW) / 2;
  } else {
    // Viewport is taller than image: letterbox (black bars on top & bottom)
    renderH = viewport.width / imageRatio;
    offsetY = (viewport.height - renderH) / 2;
  }

  return {
    x: offsetX,
    y: offsetY,
    width: renderW,
    height: renderH,
  };
}

/**
 * Precomputes an ImageTransform for fast coordinate mapping between view and screenshot.
 */
export function createImageTransform(
  viewport: ViewportGeometry,
  screenshot: Dimensions,
): ImageTransform {
  const containedRect = computeContainedImageBounds(viewport, screenshot);
  // scale is (contained view pixels / screenshot pixels)
  const scale = containedRect.width / screenshot.width;
  return {
    viewport,
    screenshot,
    containedRect,
    scale,
  };
}

/**
 * Maps a point from view/client coordinates to canonical screenshot pixel coordinates.
 * Returns undefined if the point falls outside the contained image (letterbox/pillarbox).
 */
export function viewPointToImage(
  point: Point,
  transform: ImageTransform,
): Point | undefined {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    return undefined;
  }

  const { containedRect, screenshot, scale } = transform;

  const relX = point.x - containedRect.x;
  const relY = point.y - containedRect.y;

  if (
    relX < 0 ||
    relX > containedRect.width ||
    relY < 0 ||
    relY > containedRect.height
  ) {
    return undefined;
  }

  const imgX = Math.round(relX / scale);
  const imgY = Math.round(relY / scale);

  return {
    x: Math.max(0, Math.min(screenshot.width, imgX)),
    y: Math.max(0, Math.min(screenshot.height, imgY)),
  };
}

/**
 * Maps a point in canonical screenshot pixel coordinates to view/client coordinates.
 */
export function imagePointToView(
  point: Point,
  transform: ImageTransform,
): Point {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error('Point coordinates must be finite numbers');
  }
  const { containedRect, scale } = transform;
  return {
    x: containedRect.x + point.x * scale,
    y: containedRect.y + point.y * scale,
  };
}

/**
 * Maps a screenshot pixel RegionBox to a view/client space RegionBox.
 */
export function imageBoundsToView(
  bounds: RegionBox,
  transform: ImageTransform,
): RegionBox {
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height)
  ) {
    throw new Error('Bounds coordinates must be finite numbers');
  }
  const { containedRect, scale } = transform;
  return {
    x: containedRect.x + bounds.x * scale,
    y: containedRect.y + bounds.y * scale,
    width: bounds.width * scale,
    height: bounds.height * scale,
  };
}

/**
 * Maps a view/client space RegionBox to a normalized screenshot pixel RegionBox.
 * Returns undefined if the box falls entirely outside the contained image or
 * collapses to zero area in screenshot pixels.
 */
export function viewBoundsToImage(
  viewBox: RegionBox,
  transform: ImageTransform,
): RegionBox | undefined {
  if (
    !Number.isFinite(viewBox.x) ||
    !Number.isFinite(viewBox.y) ||
    !Number.isFinite(viewBox.width) ||
    !Number.isFinite(viewBox.height)
  ) {
    return undefined;
  }

  let vx = viewBox.x;
  let vy = viewBox.y;
  let vw = viewBox.width;
  let vh = viewBox.height;

  if (vw < 0) {
    vx += vw;
    vw = -vw;
  }
  if (vh < 0) {
    vy += vh;
    vh = -vh;
  }

  const { containedRect, screenshot, scale } = transform;

  // Intersect viewBox with containedRect
  const intersectX1 = Math.max(vx, containedRect.x);
  const intersectY1 = Math.max(vy, containedRect.y);
  const intersectX2 = Math.min(vx + vw, containedRect.x + containedRect.width);
  const intersectY2 = Math.min(vy + vh, containedRect.y + containedRect.height);

  if (intersectX2 <= intersectX1 || intersectY2 <= intersectY1) {
    // Outside contained image
    return undefined;
  }

  const relX1 = intersectX1 - containedRect.x;
  const relY1 = intersectY1 - containedRect.y;
  const relX2 = intersectX2 - containedRect.x;
  const relY2 = intersectY2 - containedRect.y;

  const imgX1 = Math.max(0, Math.min(screenshot.width, Math.round(relX1 / scale)));
  const imgY1 = Math.max(0, Math.min(screenshot.height, Math.round(relY1 / scale)));
  const imgX2 = Math.max(0, Math.min(screenshot.width, Math.round(relX2 / scale)));
  const imgY2 = Math.max(0, Math.min(screenshot.height, Math.round(relY2 / scale)));

  const imgW = imgX2 - imgX1;
  const imgH = imgY2 - imgY1;

  if (imgW <= 0 || imgH <= 0) {
    return undefined;
  }

  return {
    x: imgX1,
    y: imgY1,
    width: imgW,
    height: imgH,
  };
}
