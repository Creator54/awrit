import { expect, test } from 'bun:test';
import type { ShmGraphicBuffer } from 'awrit-native-rs';
import { createTerminalGraphics, paintImage } from './kittyGraphics';
import { createTerminalOutput } from './output';

test('PNG animation uploads use frame replies and quiet composition controls', () => {
  const writes: string[] = [];
  const graphics = createTerminalGraphics(createTerminalOutput((data) => writes.push(data)));
  const image = graphics.paintPngAnimation(
    '/tmp/root.png',
    { width: 4, height: 3 },
    { x: { cell: 0, px: 0 }, y: { cell: 0, px: 0 } },
  );
  const frame = image.loadFrameFile(2, '/tmp/page.png', { width: 4, height: 3 });
  frame.composite({ x: 0, y: 0, width: 4, height: 3 }, true);
  frame.delete();
  image.free();
  const command = writes.join('');
  expect(command).toContain(`a=a,i=${image.id},c=1,q=1`);
  expect(command).toContain(`a=f,q=0,i=${image.id},r=2,X=1`);
  expect(command).toContain(`a=c,q=1,C=0,i=${image.id},r=2,c=1`);
  expect(command).toContain(`a=d,d=f,i=${image.id},r=2,q=1`);
  expect(command).toContain(`a=d,d=I,i=${image.id}`);
});

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
