import { GFX } from './escapeCodes';
import type { Rect, Size } from './graphics';
import { options } from '../args';
import { ShmGraphicBuffer } from 'awrit-native-rs';
import { defaultOutput, type TerminalOutput } from './output';

export function createTerminalGraphics(
  output: TerminalOutput,
  retain?: (id: number, buffer: ShmGraphicBuffer) => void,
) {
  const { placeCursor, write } = output;

  let imageId_ = 1;

  type ImageId = number & {};
  function imageId(): ImageId {
    return imageId_++;
  }

  const quiet = retain || options['debug-paint'] ? ',q=0' : ',q=2';

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

  function pngFile_(pathBase64: string, size: Size, control: string) {
    // f=100 PNG
    // t=t temporary file, which the terminal deletes after reading
    write(GFX`f=100,t=t${sv_size_(size)},${control};${pathBase64}`);
  }

  function paintControl(control?: string) {
    // a=T transfer & display
    // C=1 don't move cursor
    return `a=T${quiet},C=1${control == null ? '' : ',' + control}`;
  }

  function paintBitmap(name: string, size: Size, control?: string) {
    shmRgba_(name, size, paintControl(control));
  }

  interface PaintedPng {
    readonly id: ImageId;
    free: () => void;
  }

  interface AnimationFrame {
    readonly size: Size;
    composite: (destinationRect: Rect, blend?: boolean) => void;
    delete: () => void;
  }

  interface InitialFrame {
    readonly size: Size;
    paintedContent: number;
    buffer: WeakRef<ShmGraphicBuffer>;
    loadFrame: (frame: number, buffer: ShmGraphicBuffer, size: Size) => AnimationFrame;
    free: () => void;
  }

  function paintInitialFrame(
    buffer: ShmGraphicBuffer,
    size: Size,
    options?: { z?: number },
  ): InitialFrame {
    const id = imageId();
    const zStr = options?.z !== undefined ? `,z=${options.z}` : '';
    // paint and transfer first frame
    retain?.(id, buffer);
    paintBitmap(buffer.nameBase64, size, `i=${id}${zStr}`);
    // pause at the first frame
    write(GFX`a=a,i=${id},c=1`);

    return {
      size,
      paintedContent: 0,
      buffer: new WeakRef(buffer),
      loadFrame: (frame: number, buffer: ShmGraphicBuffer, size: Size) =>
        loadFrame(id, frame, buffer, size),
      free: () => freeImage(id),
    };
  }

  function loadFrame(
    id: ImageId,
    frame: number,
    buffer: ShmGraphicBuffer,
    size: Size,
  ): AnimationFrame {
    // a=f animation frame
    retain?.(id, buffer);
    shmRgba_(buffer.nameBase64, size, `a=f${quiet},i=${id},r=${frame},X=1`);

    return {
      size,
      composite: (destinationRect: Rect, blend = false) =>
        compositeFrame(id, frame, 1, destinationRect, blend),
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
    blend = false,
  ) {
    // a=c composite animation frame
    // C=1 replace pixels (src copy)
    write(
      GFX`a=c${quiet},C=${blend ? 0 : 1},i=${id},r=${sourceFrame},c=${destinationFrame}${rect_(destinationRect)}`,
    );
  }

  function clearPlacements() {
    write(GFX`a=d,d=A`);
  }

  function freeImage(id: ImageId) {
    // a=d,d=I delete image
    write(GFX`a=d,d=I,i=${id}`);
  }

  // Ghostty and probably most other terminals only support a very small
  // subset of the graphics protocol, so this just supports an initial paint,
  // and then replacing under the same buffer before releasing
  interface PaintedImage {
    readonly id: ImageId;
    readonly size: Size;
    buffer: ShmGraphicBuffer;
    free: () => void;
    replace: (buffer: Buffer) => void;
    replacePlacement: (
      buffer: ShmGraphicBuffer,
      size: Size,
      position: { x: { cell: number; px: number }; y: { cell: number; px: number } },
      options?: { z?: number },
    ) => PaintedImage;
  }

  function paintImage(
    buffer: ShmGraphicBuffer,
    size: Size,
    position: { x: { cell: number; px: number }; y: { cell: number; px: number } },
    options?: { z?: number },
  ): PaintedImage {
    const id = imageId();
    const zStr = options?.z !== undefined ? `,z=${options.z}` : '';
    placeCursor({ x: position.x.cell, y: position.y.cell });
    const control = `i=${id},X=${position.x.px},Y=${position.y.px}${zStr}`;
    retain?.(id, buffer);
    paintBitmap(buffer.nameBase64, size, control);

    return {
      id,
      size,
      buffer,
      free: () => freeImage(id),
      replacePlacement: (nextBuffer, nextSize, nextPosition, nextOptions) => {
        freeImage(id);
        return paintImage(nextBuffer, nextSize, nextPosition, nextOptions);
      },
      replace: (buffer_) => {
        // A queued transfer owns its segment until Kitty acknowledges consumption.
        if (retain) buffer = new ShmGraphicBuffer(size.width * size.height * 4);
        buffer.write(buffer_, size.width);
        // freeImage(id);
        placeCursor({ x: position.x.cell, y: position.y.cell });
        retain?.(id, buffer);
        paintBitmap(buffer.nameBase64, size, control);
      },
    };
  }
  function paintPngFile(
    file: string,
    size: Size,
    position: { x: { cell: number; px: number }; y: { cell: number; px: number } },
    options?: { z?: number; cells?: { cols: number; rows: number } },
  ): PaintedPng {
    const id = imageId();
    const zStr = options?.z !== undefined ? `,z=${options.z}` : '';
    // c/r scale the image to cover that many cells.
    const cellStr = options?.cells ? `,c=${options.cells.cols},r=${options.cells.rows}` : '';
    placeCursor({ x: position.x.cell, y: position.y.cell });
    const control = `i=${id},X=${position.x.px},Y=${position.y.px}${zStr}${cellStr}`;
    pngFile_(Buffer.from(file).toString('base64'), size, paintControl(control));
    return { id, free: () => freeImage(id) };
  }

  function paintPngAnimation(
    file: string,
    size: Size,
    position: { x: { cell: number; px: number }; y: { cell: number; px: number } },
  ) {
    const image = paintPngFile(file, size, position, { z: 0 });
    // Successful controls need no reply; errors remain visible. Only upload
    // acknowledgements should return remote frame credit.
    write(GFX`a=a,i=${image.id},c=1,q=1`);
    return {
      ...image,
      loadFrameFile(frame: number, file: string, size: Size): AnimationFrame {
        pngFile_(
          Buffer.from(file).toString('base64'),
          size,
          `a=f,q=0,i=${image.id},r=${frame},X=1`,
        );
        return {
          size,
          composite(destinationRect: Rect, blend = false) {
            write(
              GFX`a=c,q=1,C=${blend ? 0 : 1},i=${image.id},r=${frame},c=1${rect_(destinationRect)}`,
            );
          },
          delete() {
            write(GFX`a=d,d=f,i=${image.id},r=${frame},q=1`);
          },
        };
      },
    };
  }

  return { paintInitialFrame, clearPlacements, paintImage, paintPngFile, paintPngAnimation };
}

export type TerminalGraphics = ReturnType<typeof createTerminalGraphics>;
export type InitialFrame = ReturnType<TerminalGraphics['paintInitialFrame']>;
export type AnimationFrame = ReturnType<InitialFrame['loadFrame']>;
export type PaintedImage = ReturnType<TerminalGraphics['paintImage']>;
export const defaultGraphics = createTerminalGraphics(defaultOutput);
export const { paintInitialFrame, clearPlacements, paintImage } = defaultGraphics;
