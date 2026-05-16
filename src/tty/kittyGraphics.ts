import { GFX } from './escapeCodes';
import type { Rect, Size } from './graphics';
import { options } from '../args';
import type { ShmGraphicBuffer } from 'awrit-native-rs';
import { placeCursor, write } from './output';

let imageId_ = 1;

type ImageId = number & {};
function imageId(): ImageId {
  return imageId_++;
}

const quiet = options['debug-paint'] ? '' : ',q=2';

function sv_size_(size: Size) {
  return `,s=${size.width},v=${size.height}`;
}

function rect_(rect: Rect) {
  return `,x=${rect.x},y=${rect.y},w=${rect.width},h=${rect.height}`;
}

function shmRgba_(nameBase64: string, size: Size, control: string) {
  // f=32 rgba 32-bit
  // t=s SHM name
  write(GFX`f=32,t=s${sv_size_(size)},${control};${nameBase64}`);
}

function paintBitmap(name: string, size: Size, control?: string) {
  // a=T transfer & display
  // C=1 don't move cursor
  shmRgba_(name, size, `a=T${quiet},C=1${control == null ? '' : ',' + control}`);
}

export interface AnimationFrame {
  readonly size: Size;
  composite: (destinationRect: Rect) => void;
  delete: () => void;
}

export interface InitialFrame {
  readonly size: Size;
  paintedContent: number;
  buffer: WeakRef<ShmGraphicBuffer>;
  loadFrame: (frame: number, buffer: ShmGraphicBuffer, size: Size) => AnimationFrame;
  free: () => void;
}

export function paintInitialFrame(buffer: ShmGraphicBuffer, size: Size, options?: { z?: number }): InitialFrame {
  const id = imageId();
  const zStr = options?.z !== undefined ? `,z=${options.z}` : '';
  // paint and transfer first frame
  paintBitmap(buffer.nameBase64, size, `i=${id}${zStr}`);
  // pause at the first frame
  write(GFX`a=a,i=${id},c=1`);

  return {
    size,
    paintedContent: 0,
    buffer: new WeakRef(buffer),
    loadFrame: (frame: number, buffer: ShmGraphicBuffer, size: Size) =>
      loadFrame(id, frame, buffer.nameBase64, size),
    free: () => freeImage(id),
  };
}

function loadFrame(id: ImageId, frame: number, nameBase64: string, size: Size): AnimationFrame {
  // a=f animation frame
  shmRgba_(nameBase64, size, `a=f${quiet},i=${id},r=${frame},X=1`);

  return {
    size,
    composite: (destinationRect: Rect) => compositeFrame(id, frame, 1, destinationRect),
    delete: () => deleteFrame(id, frame),
  };
}

function deleteFrame(id: ImageId, frame: number) {
  // a=d,d=F delete animation frame, freeing data
  write(GFX`a=d,d=f,i=${id},r=${frame}`);
}

function compositeFrame(
  id: ImageId,
  sourceFrame: number,
  destinationFrame: number,
  destinationRect: Rect = { x: 0, y: 0, width: 0, height: 0 },
) {
  // a=c composite animation frame
  // C=1 replace pixels (src copy)
  write(
    GFX`a=c${quiet},C=1,i=${id},r=${sourceFrame},c=${destinationFrame}${rect_(destinationRect)}`,
  );
}

export function clearPlacements() {
  write(GFX`a=d,d=A`);
}

function freeImage(id: ImageId) {
  // a=d,d=I delete image
  write(GFX`a=d,d=I,i=${id}`);
}

// Ghostty and probably most other terminals only support a very small
// subset of the graphics protocol, so this just supports an initial paint,
// and then replacing under the same buffer before releasing
export interface PaintedImage {
  readonly id: ImageId;
  readonly size: Size;
  buffer: ShmGraphicBuffer;
  free: () => void;
  replace: (buffer: Buffer) => void;
}

export function paintImage(
  buffer: ShmGraphicBuffer,
  size: Size,
  position: { x: { cell: number; px: number }; y: { cell: number; px: number } },
): PaintedImage {
  const id = imageId();
  placeCursor({ x: position.x.cell, y: position.y.cell });
  const control = `i=${id},X=${position.x.px},Y=${position.y.px}`;
  paintBitmap(buffer.nameBase64, size, control);

  return {
    id,
    size,
    buffer,
    free: () => freeImage(id),
    replace: (buffer_) => {
      buffer.write(buffer_, size.width);
      // freeImage(id);
      placeCursor({ x: position.x.cell, y: position.y.cell });
      paintBitmap(buffer.nameBase64, size, control);
    },
  };
}
