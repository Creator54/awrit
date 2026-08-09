import { expect, test } from 'bun:test';
import type { ShmGraphicBuffer } from 'awrit-native-rs';
import { paintImage } from './kittyGraphics';

test('placement replacement deletes the old image before drawing the new one', () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;

  try {
    const position = { x: { cell: 0, px: 0 }, y: { cell: 0, px: 0 } };
    const first = paintImage(
      { nameBase64: 'first' } as ShmGraphicBuffer,
      { width: 4, height: 3 },
      position,
      { z: 1 },
    );
    writes.length = 0;

    first.replacePlacement(
      { nameBase64: 'second' } as ShmGraphicBuffer,
      { width: 4, height: 3 },
      position,
      { z: 1 },
    );
  } finally {
    process.stdout.write = originalWrite;
  }

  const command = writes.join('');
  expect(command.indexOf('a=d,d=I')).toBeLessThan(command.indexOf('a=T'));
  expect(command).toContain('z=1');
});
