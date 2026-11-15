import { crc32, deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const COLOR_TYPE_RGB = 2;
const COLOR_TYPE_RGBA = 6;

/**
 * Encodes an Electron `NativeImage.toBitmap()` bitmap (BGRA on little-endian hosts)
 * as an 8-bit PNG. Alpha is dropped only when every pixel is fully opaque.
 */
export function encodePng(bgra: Uint8Array, width: number, height: number): Buffer {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1)
    throw new Error('Invalid PNG dimensions');
  if (bgra.byteLength !== width * height * 4) throw new Error('Invalid PNG bitmap length');

  let opaque = true;
  for (let offset = 3; offset < bgra.byteLength; offset += 4) {
    if (bgra[offset] !== 255) {
      opaque = false;
      break;
    }
  }
  const channels = opaque ? 3 : 4;
  const rowBytes = width * channels;

  // Filter byte 0 (none) per row, then BGRA -> RGBA/RGB.
  const raw = Buffer.allocUnsafeSlow((rowBytes + 1) * height);
  let source = 0;
  let target = 0;
  for (let y = 0; y < height; y++) {
    raw[target++] = 0;
    for (let x = 0; x < width; x++) {
      raw[target++] = bgra[source + 2];
      raw[target++] = bgra[source + 1];
      raw[target++] = bgra[source];
      if (!opaque) raw[target++] = bgra[source + 3];
      source += 4;
    }
  }
  const idat = deflateSync(raw, { level: 1 });

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = opaque ? COLOR_TYPE_RGB : COLOR_TYPE_RGBA;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // One dedicated buffer, so a worker can transfer it without touching a pool.
  const png = Buffer.allocUnsafeSlow(
    SIGNATURE.length + 12 + ihdr.length + 12 + idat.length + 12,
  );
  SIGNATURE.copy(png, 0);
  let offset = SIGNATURE.length;
  const writeChunk = (type: string, data: Uint8Array) => {
    png.writeUInt32BE(data.length, offset);
    png.write(type, offset + 4, 4, 'ascii');
    png.set(data, offset + 8);
    png.writeUInt32BE(crc32(png.subarray(offset + 4, offset + 8 + data.length)), offset + 8 + data.length);
    offset += 12 + data.length;
  };
  writeChunk('IHDR', ihdr);
  writeChunk('IDAT', idat);
  writeChunk('IEND', Buffer.alloc(0));
  return png;
}
