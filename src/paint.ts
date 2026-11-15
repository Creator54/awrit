import { frameTrace } from './frameTrace';
import { ShmGraphicBuffer, getWindowSize as rawGetWindowSize } from 'awrit-native-rs';
import { rememberTabThumbnail } from './tabThumbnail';
import type { BrowserWindow, NativeImage, Rectangle } from 'electron';
import { abort } from './abort';
import { options } from './args';
import { console_ } from './console';
import { features } from './features';
import type { LayoutNode } from './layout';
import {
  type AnimationFrame,
  type InitialFrame,
  type PaintedImage,
  paintImage,
} from './tty/kittyGraphics';
import { Mode } from './tty/output';
import type { TerminalContext } from './terminal/context';
import type { FrameSink } from './remote/frameSink';
import * as defaultOutput from './tty/output';

export function getWindowSize() {
  try {
    return rawGetWindowSize();
  } catch (e) {
    console_.error('Failed to get window size:', e);
    return { width: 0, height: 0, cols: 0, rows: 0 };
  }
}

type PaintedContent = {
  frame?: AnimationFrame;
  buffer?: ShmGraphicBuffer;
  size?: number;
  expectedWinSize?: {
    width: number;
    height: number;
  };
  snapshot?(): { bitmap?: Buffer; size?: { width: number; height: number }; overlayBitmap?: Buffer; overlaySize?: { width: number; height: number } };
  refresh(): void;
  destroy(): void;
};

/**
 * Deterministic "mostly white" test used by the flash-killer.
 *
 * Random sampling (the previous approach) gave different verdicts on every
 * frame, so a white page could randomly sample non-white pixels and flash,
 * while a real page could randomly sample white pixels and get over-suppressed.
 * A fixed stride over the bitmap is deterministic and far cheaper to reason about.
 */
function isMostlyWhite(buffer: Buffer, width: number, height: number): boolean {
  const totalPixels = width * height;
  if (totalPixels === 0) return false;
  // Sample at a fixed stride: covers the whole frame evenly, ~1 sample per 4k pixels.
  const stride = Math.max(1, Math.floor(totalPixels / 200));
  let whitePixels = 0;
  let sampled = 0;
  for (let p = 0; p < totalPixels; p += stride) {
    const idx = p * 4;
    if (buffer[idx] > 240 && buffer[idx + 1] > 240 && buffer[idx + 2] > 240) {
      whitePixels++;
    }
    sampled++;
  }
  // Require > 90% of sampled pixels to be near-white to keep the page hidden.
  return sampled > 0 && whitePixels / sampled > 0.9;
}

const weakPaintedContents_ = new WeakMap<BrowserWindow, PaintedContent>();

// assumes animation is supported
/** One BGRA cover pixel in the terminal background (black when Kitty did not report it); `clear` makes it see-through. */
export function coverPixel(terminal?: TerminalContext, clear = false): Uint8Array {
  const hex = terminal?.identity.terminalBackground?.slice(1) ?? '000000';
  const [r, g, b] = [0, 2, 4].map(i => Number.parseInt(hex.slice(i, i + 2), 16));
  return Uint8Array.from([b, g, r, clear ? 0 : 255]);
}

export function registerPaintedContent(
  containerFrame: InitialFrame,
  w: BrowserWindow,
  layoutNode: LayoutNode,
  terminal?: TerminalContext,
  isActive: () => boolean = () => true,
  sink?: FrameSink,
  overlay?: { window: BrowserWindow; layout: LayoutNode },
): PaintedContent {
  const { setModes, startBatch, endBatch } = terminal?.output ?? defaultOutput;
  const contents = w.webContents;
  const frameNumber = 2 + containerFrame.paintedContent++;

  const previous = weakPaintedContents_.get(w)?.snapshot?.();
  let lastImageSize = previous?.size;
  let lastBitmap = previous?.bitmap;
  let blackBuffer: ShmGraphicBuffer | undefined;
  let blackSize = 0;
  let overlayBitmap: Buffer | undefined;
  let overlayBuffer: ShmGraphicBuffer | undefined;
  let overlayFrame: AnimationFrame | undefined;
  let contentFrame: AnimationFrame | undefined;
  let coverFrame: AnimationFrame | undefined;
  let coverFrameNumber: number | undefined;
  let overlaySize: { width: number; height: number } | undefined;
  const overlayFrameNumber = overlay ? 2 + containerFrame.paintedContent++ : undefined;

  // Kitty composition copies pixels, not scales; retained resize frames
  // can be smaller than the new viewport until Chromium paints again.
  function copyRect(size: { width: number; height: number }, node: LayoutNode) {
    return { ...node.deviceLayout,
      width: Math.min(size.width, node.deviceLayout.width),
      height: Math.min(size.height, node.deviceLayout.height) };
  }

  function drawOverlay() {
    if (!overlay || !overlayBuffer || !overlaySize || overlayFrameNumber === undefined) return;
    overlayFrame?.composite(copyRect(overlaySize, overlay.layout), true);
  }

  function submitOverlay() {
    if (!sink || !overlay || !overlayBitmap || !overlaySize) return;
    sink.submit({
      surface: 'toolbar',
      bitmap: overlayBitmap,
      width: overlaySize.width,
      height: overlaySize.height,
      x: overlay.layout.deviceLayout.x,
      y: overlay.layout.deviceLayout.y,
      z: 1,
    });
  }

  function paintOverlay(_: unknown, _dirty: Rectangle, image: NativeImage) {
    if (
      destroyed ||
      !isActive() ||
      (terminal && !terminal.canPaint()) ||
      (terminal?.settings.noPaint ?? options['no-paint'])
    )
      return;
    const size = image.getSize();
    if (!size.width || !size.height) return;
    // Electron can deliver a queued pre-resize frame after the layout changes.
    if (!overlay || size.width !== overlay.layout.deviceLayout.width || size.height !== overlay.layout.deviceLayout.height) return;
    if (sink) {
      overlayBitmap = image.toBitmap();
      overlaySize = size;
      submitOverlay();
      return;
    }
    if (!overlayBuffer || overlaySize?.width !== size.width || overlaySize.height !== size.height) {
      overlayBuffer = new ShmGraphicBuffer(size.width * size.height * 4);
    }
    const startedAt = frameTrace.enabled ? frameTrace.now() : 0;
    try {
      overlayBitmap = image.toBitmap();
      overlayBuffer.write(overlayBitmap, size.width);
      overlaySize = size;
      // A blank page may not emit a paint after resize. Initialize its slot
      // before uploading the toolbar so frame numbers remain contiguous.
      if (!contentFrame && !coverFrame) drawCover();
      if (overlayFrameNumber !== undefined) {
        overlayFrame = containerFrame.loadFrame(overlayFrameNumber, overlayBuffer, size);
      }
      result.refresh();
    } finally {
      if (frameTrace.enabled) frameTrace.record('overlay', startedAt);
    }
  }

  if (!(terminal?.features ?? features.current)) {
    console_.error('No features available');
    abort();
  }

  let destroyed = false;
  const result: PaintedContent = {
    snapshot: () => ({ bitmap: lastBitmap, size: lastImageSize, overlayBitmap, overlaySize }),
    refresh() {
      if (sink && isActive() && !destroyed) submitOverlay();
      if (sink) {
        if (isActive() && !destroyed) submitFrame();
        return;
      }
      if (!lastImageSize && isActive() && !destroyed) {
        drawCover();
        return;
      }
      if (
        isActive() &&
        !destroyed &&
        result.buffer &&
        lastImageSize &&
        (!terminal || terminal.canPaint())
      ) {
        setModes([Mode.pendingUpdate], true);
        // The blank fill and the page share a slot; restore the retained page.
        if (lastBitmap) result.buffer.write(lastBitmap, lastImageSize.width);
        contentFrame = containerFrame.loadFrame(frameNumber, result.buffer, lastImageSize);
        contentFrame.composite(copyRect(lastImageSize, layoutNode));
        drawOverlay();
        setModes([Mode.pendingUpdate], false);
      }
    },
    destroy() {
      destroyed = true;
      contents.off('paint', paint);
      overlay?.window.webContents.off('paint', paintOverlay);
      overlayFrame?.delete();
      contentFrame?.delete();
      coverFrame?.delete();
      overlayFrame = contentFrame = coverFrame = undefined;
      overlayBuffer = undefined;
      overlayBitmap = undefined;
      result.buffer = undefined;
      lastBitmap = undefined;
      result.frame?.delete();
      result.frame = undefined;
    },
  };

  /** Remote surface: send the last bitmap and its current destination geometry. */
  function submitFrame() {
    if (!sink) return;
    const size = lastImageSize;
    const bitmap = lastBitmap;
    if (!size || !bitmap) return;
    sink.submit({
      surface: 'content',
      bitmap,
      width: size.width,
      height: size.height,
      x: layoutNode.deviceLayout.x,
      y: layoutNode.deviceLayout.y,
      z: 0,
    });
  }

  function drawCover() {
    const size = lastImageSize ?? layoutNode.deviceLayout;
    if (!isActive() || destroyed || !size || (terminal && !terminal.canPaint())) return;
    const bytes = size.width * size.height * 4;
    if (!blackBuffer || blackSize !== bytes) {
      blackBuffer = new ShmGraphicBuffer(bytes);
      blackSize = bytes;
    }
    blackBuffer.write(Buffer.alloc(bytes).fill(coverPixel(terminal)), size.width);
    coverFrameNumber ??= frameNumber;
    coverFrame = containerFrame.loadFrame(coverFrameNumber, blackBuffer, size);
    setModes([Mode.pendingUpdate], true);
    coverFrame?.composite(copyRect(size, layoutNode));
    drawOverlay();
    setModes([Mode.pendingUpdate], false);
  }

  async function paint(_: any, _dirty: Rectangle, image: NativeImage) {
    if (!isActive()) {
      frameTrace.skip('inactive');
      return;
    }
    if (destroyed) {
      frameTrace.skip('destroyed');
      return;
    }
    if (terminal?.settings.noPaint ?? options['no-paint']) {
      frameTrace.skip('noPaint');
      return;
    }
    if (terminal && !terminal.canPaint()) {
      frameTrace.skip('credit');
      return;
    }

    const imageSize = image.getSize();
    if (imageSize.width === 0 || imageSize.height === 0) return;

    rememberTabThumbnail(contents, image);

    // Content Detection logic for Zero-Latency Swap
    // We count frames even while suppressing so we know when the site is ready.
    if ((w as any).isSuppressingPaint) {
      (w as any).paintCount = ((w as any).paintCount || 0) + 1;

      // We wait for 5 frames (~80ms at 60fps) as a base.
      // Combined with the whiteness filter below, this is plenty.
      if ((w as any).paintCount >= 5) {
        w.emit('content-ready');
      }
      return;
    }

    if (sink) {
      const bitmap = image.toBitmap();
      lastBitmap = bitmap;
      lastImageSize = imageSize;
      submitFrame();
      return;
    }

    if (frameTrace.enabled) frameTrace.dirtyArea(_dirty, imageSize);
    const imageBufferSize = imageSize.width * imageSize.height * 4;

    if (result.buffer == null || (result.size != null && imageBufferSize !== result.size)) {
      if ((terminal?.settings.debugPaint ?? options['debug-paint']) && result.buffer) {
        console_.error('replace buffer', result.buffer.nameBase64, result.size, imageBufferSize);
      }
      result.buffer = new ShmGraphicBuffer(imageBufferSize);
      result.size = imageBufferSize;
    }

    const t0 = frameTrace.now();
    const buffer = image.toBitmap();
    frameTrace.record('toBitmap', t0);
    lastBitmap = buffer;

    const t2 = frameTrace.now();
    result.buffer.write(buffer, imageSize.width);
    frameTrace.record('write', t2);

    const t3 = frameTrace.now();
    startBatch();
    try {
      setModes([Mode.pendingUpdate], true);
      lastImageSize = imageSize;
      contentFrame = containerFrame.loadFrame(frameNumber, result.buffer, imageSize);
      contentFrame.composite(copyRect(imageSize, layoutNode));
      drawOverlay();
    } finally {
      setModes([Mode.pendingUpdate], false);
      endBatch();
      frameTrace.record('emit', t3);
      frameTrace.record('total', t0);
    }
  }

  contents.on('paint', paint);
  overlay?.window.webContents.on('paint', paintOverlay);

  // Keep the previous page and review visible until Chromium paints the new size.
  if (!sink && previous && isActive() && !(terminal?.settings.noPaint ?? options['no-paint']) && (!terminal || terminal.canPaint())) {
    if (lastBitmap && lastImageSize) {
      result.buffer = new ShmGraphicBuffer(lastBitmap.length);
      result.size = lastBitmap.length;
      result.buffer.write(lastBitmap, lastImageSize.width);
      contentFrame = containerFrame.loadFrame(frameNumber, result.buffer, lastImageSize);
    }
    if (overlay && previous.overlayBitmap && previous.overlaySize) {
      overlaySize = previous.overlaySize;
      overlayBitmap = previous.overlayBitmap;
      overlayBuffer = new ShmGraphicBuffer(overlayBitmap.length);
      overlayBuffer.write(overlayBitmap, overlaySize.width);
      if (!contentFrame) drawCover();
      if (overlayFrameNumber !== undefined)
        overlayFrame = containerFrame.loadFrame(overlayFrameNumber, overlayBuffer, overlaySize);
    }
    result.refresh();
  }
  weakPaintedContents_.set(w, result);
  return result;
}

function coordsFromPx(cellToPx: number, px: number) {
  return {
    cell: Math.ceil(px / cellToPx),
    px: Math.ceil(px % cellToPx),
  };
}

export function registerPaintedContentFallback(
  w: BrowserWindow,
  layoutNode: LayoutNode,
  z?: number,
  renderOptions: { replacePlacement?: boolean } = {},
  terminal?: TerminalContext,
  isActive: () => boolean = () => true,
  cacheThumbnail = false,
): PaintedContent {
  const { setModes, startBatch, endBatch } = terminal?.output ?? defaultOutput;
  const paintImageForTerminal = terminal?.graphics.paintImage ?? paintImage;
  const contents = w.webContents;
  let paintedImage: PaintedImage | undefined;
  let reuseBuffer = false;
  let destroyed = false;
  const previous = weakPaintedContents_.get(w)?.snapshot?.();
  let lastBitmap = previous?.bitmap;
  let lastImageSize = previous?.size;

  const result: PaintedContent = {
    snapshot: () => ({ bitmap: lastBitmap, size: lastImageSize }),
    refresh() {
      if (!isActive() || destroyed || !lastImageSize || (terminal && !terminal.canPaint())) return;
      const size = terminal?.size ?? getWindowSize();
      if (!size.cols || !size.rows) return;
      const buffer = result.buffer;
      const imageSize = lastImageSize;
      if (!buffer) return;
      paintedImage?.free();
      paintedImage = paintImageForTerminal(buffer, imageSize, {
        x: coordsFromPx(size.width / size.cols, layoutNode.deviceLayout.x),
        y: coordsFromPx(size.height / size.rows, layoutNode.deviceLayout.y),
      }, z !== undefined ? { z } : undefined);
    },
    destroy() {
      destroyed = true;
      contents.off('paint', paint);
      result.buffer = undefined;
      paintedImage?.free();
      paintedImage = undefined;
    },
  };

  async function paint(_: any, dirty: Rectangle, image: NativeImage) {
    if (
      !isActive() ||
      destroyed ||
      (terminal?.settings.noPaint ?? options['no-paint']) ||
      (terminal && !terminal.canPaint())
    )
      return;

    const imageSize = image.getSize();
    if (imageSize.width === 0 || imageSize.height === 0) return;

    if ((w as any).isSuppressingPaint) {
      (w as any).paintCount = ((w as any).paintCount || 0) + 1;
      if ((w as any).paintCount >= 5) {
        w.emit('content-ready');
      }
      return;
    }

    const imageBufferSize = imageSize.width * imageSize.height * 4;

    if (cacheThumbnail) rememberTabThumbnail(contents, image);
    lastImageSize = imageSize;

    // Recompute cell metrics on every paint so they stay correct after resize
    const termSize = terminal?.size ?? getWindowSize();
    if (termSize.cols === 0 || termSize.rows === 0) return;
    const cellToPxX = termSize.width / termSize.cols;
    const cellToPxY = termSize.height / termSize.rows;

    const position = {
      x: coordsFromPx(cellToPxX, layoutNode.deviceLayout.x),
      y: coordsFromPx(cellToPxY, layoutNode.deviceLayout.y),
    };

    let replace = true;
    if (result.buffer == null || (result.size != null && imageBufferSize !== result.size)) {
      replace = false;
      const buffer = new ShmGraphicBuffer(imageBufferSize);
      paintedImage?.free();

      const bitmap = image.toBitmap();
      lastBitmap = bitmap;
      const previousName = buffer.nameBase64;
      buffer.write(bitmap, imageSize.width);
      reuseBuffer = buffer.nameBase64 !== previousName;

      setModes([Mode.pendingUpdate], true);
      paintedImage = paintImageForTerminal(
        buffer,
        imageSize,
        position,
        z !== undefined ? { z } : undefined,
      );
      setModes([Mode.pendingUpdate], false);

      result.buffer = buffer;
      result.size = imageBufferSize;
    }
    if (terminal?.settings.debugPaint ?? options['debug-paint']) {
      console_.error(
        'paint (fallback)',
        result.buffer?.nameBase64,
        image.getSize(),
        'dirty',
        dirty,
      );
    }
    if (replace && paintedImage) {
      const bitmap = image.toBitmap();

      // Flash Killer for Fallback mode
      if ((w as any).paintCount < 60) {
        if (isMostlyWhite(bitmap, imageSize.width, imageSize.height)) {
          (w as any).paintCount++;
          return;
        }
      }

      lastBitmap = bitmap;
      startBatch();
      try {
        setModes([Mode.pendingUpdate], true);
        if (renderOptions.replacePlacement) {
          let buffer =
            reuseBuffer && result.buffer ? result.buffer : new ShmGraphicBuffer(imageBufferSize);
          const previousName = buffer.nameBase64;
          buffer.write(bitmap, imageSize.width);
          // Older native builds reuse names that Kitty has already unlinked.
          if (reuseBuffer && buffer.nameBase64 === previousName) {
            reuseBuffer = false;
            buffer = new ShmGraphicBuffer(imageBufferSize);
            buffer.write(bitmap, imageSize.width);
          }
          paintedImage = paintedImage.replacePlacement(
            buffer,
            imageSize,
            position,
            z !== undefined ? { z } : undefined,
          );
          result.buffer = buffer;
        } else {
          // Fallback mode replace() writes to buffer and triggers a redraw in terminal
          paintedImage.replace(bitmap);
        }
      } finally {
        setModes([Mode.pendingUpdate], false);
        endBatch();
      }
    }
  }

  contents.on('paint', paint);

  if (lastBitmap && lastImageSize && isActive() && !(terminal?.settings.noPaint ?? options['no-paint']) && (!terminal || terminal.canPaint())) {
    result.buffer = new ShmGraphicBuffer(lastBitmap.length);
    result.size = lastBitmap.length;
    result.buffer.write(lastBitmap, lastImageSize.width);
    result.refresh();
  }
  weakPaintedContents_.set(w, result);
  return result;
}
