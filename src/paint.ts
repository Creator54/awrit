import { ShmGraphicBuffer } from 'awrit-native-rs';
import type { BrowserWindow, NativeImage, Rectangle } from 'electron';
import { getWindowSize } from './windows';
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
import { Mode, setModes, startBatch, endBatch } from './tty/output';

type PaintedContent = {
  frame?: AnimationFrame;
  buffer?: ShmGraphicBuffer;
  size?: number;
  expectedWinSize?: {
    width: number;
    height: number;
  };
  refresh(): void;
  destroy(): void;
};

const weakPaintedContents_ = new WeakMap<BrowserWindow, PaintedContent>();

// assumes animation is supported
export function registerPaintedContent(
  containerFrame: InitialFrame,
  w: BrowserWindow,
  layoutNode: LayoutNode,
): PaintedContent {
  const contents = w.webContents;
  const frameNumber = 2 + containerFrame.paintedContent++;



  let lastImageSize: { width: number, height: number } | undefined;

  if (!features.current) {
    console_.error('No features available');
    abort();
  }

  let destroyed = false;
  const result: PaintedContent = {
    refresh() {
      if (!destroyed && result.buffer && lastImageSize) {
        setModes([Mode.pendingUpdate], true);
        containerFrame
          .loadFrame(frameNumber, result.buffer, lastImageSize)
          .composite(layoutNode.deviceLayout);
        setModes([Mode.pendingUpdate], false);
      }
    },
    destroy() {
      destroyed = true;
      contents.off('paint', paint);
      this.buffer = undefined;
      this.frame?.delete();
      this.frame = undefined;
    },
  };

  async function paint(_: any, dirty: Rectangle, image: NativeImage) {
    if (destroyed) return;

    const imageSize = image.getSize();
    if (imageSize.width === 0 || imageSize.height === 0) return;

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

    const imageBufferSize = imageSize.width * imageSize.height * 4;
    
    if (result.buffer == null || (result.size != null && imageBufferSize !== result.size)) {
      if (options['debug-paint'] && result.buffer) {
        console_.error('replace buffer', result.buffer.nameBase64, result.size, imageBufferSize);
      }
      result.buffer = new ShmGraphicBuffer(imageBufferSize);
      result.size = imageBufferSize;
    }

    const buffer = image.toBitmap();

    // Flash Killer: Check if the frame is mostly white.
    // If it is, and we just started, keep it hidden.
    // We only check for the first 30 frames to keep performance high.
    if ((w as any).isSuppressingPaint && (w as any).paintCount < 30) {
      let whitePixels = 0;
      const totalPixels = imageSize.width * imageSize.height;
      // Sample 100 pixels to check for whiteness
      for (let i = 0; i < 100; i++) {
        const idx = Math.floor(Math.random() * totalPixels) * 4;
        if (buffer[idx] > 240 && buffer[idx+1] > 240 && buffer[idx+2] > 240) {
          whitePixels++;
        }
      }
      if (whitePixels > 90) { // More than 90% white sample
        (w as any).paintCount++; 
        return;
      }
    }

    result.buffer.write(buffer, imageSize.width);

    startBatch();
    try {
      setModes([Mode.pendingUpdate], true);
      lastImageSize = imageSize;
      containerFrame
        .loadFrame(frameNumber, result.buffer, imageSize)
        .composite(layoutNode.deviceLayout);
      setModes([Mode.pendingUpdate], false);
    } finally {
      endBatch();
    }
  }

  contents.on('paint', paint);

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
): PaintedContent {
  const contents = w.webContents;
  let paintedImage: PaintedImage | undefined;

  const result: PaintedContent = {
    refresh() {
      // Refresh logic for fallback mode if needed
    },
    destroy() {
      contents.off('paint', paint);
      this.buffer = undefined;
      paintedImage?.free();
      paintedImage = undefined;
    },
  };

  async function paint(_: any, dirty: Rectangle, image: NativeImage) {
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

    // Recompute cell metrics on every paint so they stay correct after resize
    const termSize = getWindowSize();
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
      buffer.write(bitmap, imageSize.width * 4);
      
      setModes([Mode.pendingUpdate], true);
      paintedImage = paintImage(buffer, imageSize, position);
      setModes([Mode.pendingUpdate], false);

      result.buffer = buffer;
      result.size = imageBufferSize;
    }
    if (options['debug-paint']) {
      console_.error('paint (fallback)', result.buffer.nameBase64, image.getSize(), 'dirty', dirty);
    }
    if (options['no-paint']) {
      return;
    }

    if (replace && paintedImage) {
      const bitmap = image.toBitmap();

      // Flash Killer for Fallback mode
      if ((w as any).paintCount < 60) {
        let whitePixels = 0;
        const totalPixels = imageSize.width * imageSize.height;
        for (let i = 0; i < 100; i++) {
          const idx = Math.floor(Math.random() * totalPixels) * 4;
          if (bitmap[idx] > 240 && bitmap[idx+1] > 240 && bitmap[idx+2] > 240) {
            whitePixels++;
          }
        }
        if (whitePixels > 90) {
          (w as any).paintCount++;
          return;
        }
      }
      
      startBatch();
      try {
        setModes([Mode.pendingUpdate], true);
        // Fallback mode replace() writes to buffer and triggers a redraw in terminal
        paintedImage.replace(bitmap);
        setModes([Mode.pendingUpdate], false);
      } finally {
        endBatch();
      }
    }
  }

  contents.on('paint', paint);

  weakPaintedContents_.set(w, result);
  return result;
}
