import { describe, expect, test } from 'bun:test';
import type { RegionBox } from '../presentation/collaborativeCapture';
import {
  computeContainedImageBounds,
  createImageTransform,
  imageBoundsToView,
  imagePointToView,
  normalizePixelRegion,
  viewBoundsToImage,
  viewPointToImage,
} from './coordinates';
import type { ViewportGeometry } from './types';

describe('Design mode coordinate transforms', () => {
  const screenshot = { width: 1000, height: 800 };
  const viewport: ViewportGeometry = { width: 500, height: 500, dpr: 2 }; // letterboxed: screenshot is 5:4, viewport is 1:1

  test('computeContainedImageBounds computes correct letterbox/pillarbox geometry', () => {
    // 5:4 aspect in 500x500 box -> renderW = 500, renderH = 400, offsetY = 50, offsetX = 0
    const bounds = computeContainedImageBounds(viewport, screenshot);
    expect(bounds).toEqual({
      x: 0,
      y: 50,
      width: 500,
      height: 400,
    });
  });

  test('computeContainedImageBounds computes pillarbox geometry when viewport is wider', () => {
    // 1000x800 in 1000x500 viewport -> ratio 2:1 vs 5:4. renderH = 500, renderW = 500 * (1000/800) = 625, offsetX = (1000-625)/2 = 187.5
    const wideViewport: ViewportGeometry = { width: 1000, height: 500 };
    const bounds = computeContainedImageBounds(wideViewport, screenshot);
    expect(bounds.x).toBe(187.5);
    expect(bounds.y).toBe(0);
    expect(bounds.width).toBe(625);
    expect(bounds.height).toBe(500);
  });

  test('createImageTransform encapsulates viewport, screenshot, and contained rect', () => {
    const transform = createImageTransform(viewport, screenshot);
    expect(transform.viewport).toEqual(viewport);
    expect(transform.screenshot).toEqual(screenshot);
    expect(transform.containedRect).toEqual({
      x: 0,
      y: 50,
      width: 500,
      height: 400,
    });
  });

  test('viewPointToImage rejects points outside letterbox and clamps/maps valid points', () => {
    const transform = createImageTransform(viewport, screenshot);

    // Top letterbox margin (y < 50)
    expect(viewPointToImage({ x: 250, y: 20 }, transform)).toBeUndefined();
    // Bottom letterbox margin (y > 450)
    expect(viewPointToImage({ x: 250, y: 480 }, transform)).toBeUndefined();
    // Outside viewport entirely
    expect(viewPointToImage({ x: -10, y: 100 }, transform)).toBeUndefined();
    expect(viewPointToImage({ x: 600, y: 100 }, transform)).toBeUndefined();

    // Top-left of active image: (0, 50) -> image (0, 0)
    expect(viewPointToImage({ x: 0, y: 50 }, transform)).toEqual({ x: 0, y: 0 });
    // Bottom-right of active image: (500, 450) -> image (1000, 800)
    expect(viewPointToImage({ x: 500, y: 450 }, transform)).toEqual({ x: 1000, y: 800 });
    // Center: (250, 250) -> y in contained is 200, 200/400 * 800 = 400 -> image (500, 400)
    expect(viewPointToImage({ x: 250, y: 250 }, transform)).toEqual({ x: 500, y: 400 });
  });

  test('imagePointToView maps pixel coordinates back to view space', () => {
    const transform = createImageTransform(viewport, screenshot);
    expect(imagePointToView({ x: 0, y: 0 }, transform)).toEqual({ x: 0, y: 50 });
    expect(imagePointToView({ x: 500, y: 400 }, transform)).toEqual({ x: 250, y: 250 });
    expect(imagePointToView({ x: 1000, y: 800 }, transform)).toEqual({ x: 500, y: 450 });
  });

  test('imageBoundsToView maps RegionBox from screenshot pixels to view space', () => {
    const transform = createImageTransform(viewport, screenshot);
    const imageBox: RegionBox = { x: 100, y: 80, width: 200, height: 160 };
    // scale factor is 500/1000 = 0.5.
    // x: 100 * 0.5 + 0 = 50
    // y: 80 * 0.5 + 50 = 90
    // width: 200 * 0.5 = 100
    // height: 160 * 0.5 = 80
    expect(imageBoundsToView(imageBox, transform)).toEqual({
      x: 50,
      y: 90,
      width: 100,
      height: 80,
    });
  });

  test('viewBoundsToImage maps view box to screenshot pixel RegionBox with boundary clamping/rejection', () => {
    const transform = createImageTransform(viewport, screenshot);
    // Inside contained area
    const viewBox: RegionBox = { x: 50, y: 90, width: 100, height: 80 };
    expect(viewBoundsToImage(viewBox, transform)).toEqual({
      x: 100,
      y: 80,
      width: 200,
      height: 160,
    });

    // Reversed drag in view coordinates
    const reversedViewBox: RegionBox = { x: 150, y: 170, width: -100, height: -80 };
    expect(viewBoundsToImage(reversedViewBox, transform)).toEqual({
      x: 100,
      y: 80,
      width: 200,
      height: 160,
    });

    // Box completely in letterbox zone
    expect(viewBoundsToImage({ x: 50, y: 10, width: 100, height: 20 }, transform)).toBeUndefined();
  });

  test('viewBoundsToImage clamps cleanly at right/bottom edges and handles subpixel bounds', () => {
    const transform = createImageTransform(
      { width: 100, height: 100 },
      { width: 1000, height: 1000 },
    );
    // Boundary edge box that shouldn't throw an overflow
    const edgeBox = viewBoundsToImage({ x: 99, y: 99, width: 2, height: 2 }, transform);
    expect(edgeBox).toBeDefined();
    expect(edgeBox?.x).toBe(990);
    expect(edgeBox?.width).toBe(10);

    // Subpixel tiny sliver that maps to 0 screenshot pixels returns undefined instead of throwing
    const sliver = viewBoundsToImage({ x: 10, y: 10, width: 0.0001, height: 0.0001 }, transform);
    expect(sliver).toBeUndefined();
  });

  test('imagePointToView and imageBoundsToView reject non-finite inputs', () => {
    const transform = createImageTransform(
      { width: 100, height: 100 },
      { width: 200, height: 200 },
    );
    expect(() => imagePointToView({ x: Number.NaN, y: 10 }, transform)).toThrow('finite');
    expect(() =>
      imageBoundsToView({ x: 10, y: 10, width: Number.POSITIVE_INFINITY, height: 10 }, transform),
    ).toThrow('finite');
  });

  test('normalizePixelRegion normalizes reversed drag and clamps/validates to bounds', () => {
    expect(
      normalizePixelRegion({ x: 10, y: 20, width: 30, height: 40 }, screenshot.width, screenshot.height),
    ).toEqual({ x: 10, y: 20, width: 30, height: 40 });

    // Reversed drag
    expect(
      normalizePixelRegion({ x: 40, y: 60, width: -30, height: -40 }, screenshot.width, screenshot.height),
    ).toEqual({ x: 10, y: 20, width: 30, height: 40 });

    // Float rounding
    expect(
      normalizePixelRegion({ x: 10.4, y: 20.6, width: 29.8, height: 40.2 }, screenshot.width, screenshot.height),
    ).toEqual({ x: 10, y: 21, width: 30, height: 40 });

    // Out of bounds
    expect(() =>
      normalizePixelRegion({ x: -5, y: 0, width: 10, height: 10 }, screenshot.width, screenshot.height),
    ).toThrow();
    expect(() =>
      normalizePixelRegion({ x: 990, y: 790, width: 20, height: 20 }, screenshot.width, screenshot.height),
    ).toThrow();
  });
});
