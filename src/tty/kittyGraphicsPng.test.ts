import { expect, test } from 'bun:test';
import { createTerminalGraphics } from './kittyGraphics';
import { createTerminalOutput } from './output';

test('paintPngFile sends a base64 temp-file path with the placement controls', () => {
  const writes: string[] = [];
  const graphics = createTerminalGraphics(
    createTerminalOutput((data) => writes.push(data)),
    () => {},
  );
  const file = '/tmp/tty-graphics-protocol-example.png';
  const painted = graphics.paintPngFile(
    file,
    { width: 4, height: 3 },
    { x: { cell: 2, px: 10 }, y: { cell: 1, px: 5 } },
    { z: 2 },
  );

  expect(painted.id).toBe(1);
  expect(writes.join('')).toBe(
    `\x1b[1;2H\x1b_Gf=100,t=t,s=4,v=3,a=T,q=0,C=1,i=1,X=10,Y=5,z=2;${Buffer.from(file).toString('base64')}\x1b\\`,
  );
});
