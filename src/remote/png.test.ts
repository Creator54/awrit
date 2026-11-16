import { describe, expect, test } from 'bun:test';
import { crc32 as nodeCrc32, inflateSync } from 'node:zlib';
import { encodePng } from './png';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Independent CRC-32 (PNG polynomial) so a wrong implementation cannot validate itself.
const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

interface PngParts {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  bytesPerPixel: number;
  raw: Buffer;
}

function parsePng(png: Buffer): PngParts {
  expect(png.subarray(0, 8)).toEqual(SIGNATURE);
  const chunks: { type: string; data: Buffer }[] = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    expect(png.readUInt32BE(offset + 8 + length)).toBe(
      crc32(png.subarray(offset + 4, offset + 8 + length)),
    );
    chunks.push({ type, data });
    offset += 12 + length;
  }
  expect(offset).toBe(png.length);
  expect(chunks.map((chunk) => chunk.type)).toEqual(['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  expect(ihdr.length).toBe(13);
  const pixels = inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  return {
    width: ihdr.readUInt32BE(0),
    height: ihdr.readUInt32BE(4),
    bitDepth: ihdr[8],
    colorType: ihdr[9],
    bytesPerPixel: ihdr[9] === 6 ? 4 : 3,
    raw: pixels,
  };
}

// BGRA on little-endian: bytes are blue, green, red, alpha.
const twoByTwo = Buffer.from([
  10, 20, 30, 40, 50, 60, 70, 255, 80, 90, 100, 255, 110, 120, 130, 128,
]);

describe('encodePng', () => {
  test('writes RGBA pixels exactly and filters every row with zero', () => {
    const parts = parsePng(encodePng(twoByTwo, 2, 2));
    expect(parts).toMatchObject({ width: 2, height: 2, bitDepth: 8, colorType: 6 });
    expect(parts.raw).toEqual(
      Buffer.from([
        0, 30, 20, 10, 40, 70, 60, 50, 255, 0, 100, 90, 80, 255, 130, 120, 110, 128,
      ]),
    );
  });

  test('drops alpha when every pixel is opaque', () => {
    const opaque = Buffer.from([10, 20, 30, 255, 50, 60, 70, 255, 80, 90, 100, 255, 110, 120, 130, 255]);
    const parts = parsePng(encodePng(opaque, 2, 2));
    expect(parts).toMatchObject({ width: 2, height: 2, bitDepth: 8, colorType: 2 });
    expect(parts.raw).toEqual(
      Buffer.from([0, 30, 20, 10, 70, 60, 50, 0, 100, 90, 80, 130, 120, 110]),
    );
  });

  test('rejects a bitmap whose length does not match the dimensions', () => {
    expect(() => encodePng(twoByTwo, 3, 3)).toThrow();
    expect(() => encodePng(Buffer.alloc(0), 0, 0)).toThrow();
  });

  test('chunk CRCs match node:zlib', () => {
    const png = encodePng(twoByTwo, 2, 2);
    let offset = 8;
    while (offset < png.length) {
      const length = png.readUInt32BE(offset);
      expect(png.readUInt32BE(offset + 8 + length)).toBe(
        nodeCrc32(png.subarray(offset + 4, offset + 8 + length)),
      );
      offset += 12 + length;
    }
  });

  test.skipIf(!Bun.which('ffmpeg'))('decodes with ffmpeg to the same pixels', () => {
    const width = 4;
    const height = 3;
    const bgra = Buffer.alloc(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel++) {
      bgra[pixel * 4] = (pixel * 7) % 256;
      bgra[pixel * 4 + 1] = (pixel * 13) % 256;
      bgra[pixel * 4 + 2] = (pixel * 29) % 256;
      bgra[pixel * 4 + 3] = 255 - (pixel % 5) * 40;
    }
    const png = encodePng(bgra, width, height);
    const decoded = Bun.spawnSync(
      ['ffmpeg', '-v', 'error', '-f', 'png_pipe', '-i', '-', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-'],
      { stdin: png, stdout: 'pipe', stderr: 'pipe' },
    );
    expect(decoded.exitCode).toBe(0);
    const rgba = Buffer.from(decoded.stdout);
    expect(rgba.length).toBe(bgra.length);
    for (let pixel = 0; pixel < width * height; pixel++) {
      expect([
        rgba[pixel * 4],
        rgba[pixel * 4 + 1],
        rgba[pixel * 4 + 2],
        rgba[pixel * 4 + 3],
      ]).toEqual([
        bgra[pixel * 4 + 2],
        bgra[pixel * 4 + 1],
        bgra[pixel * 4],
        bgra[pixel * 4 + 3],
      ]);
    }
  });
});
