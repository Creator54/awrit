import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ShmGraphicBuffer } from 'awrit-native-rs';
import type { PaneSettings } from '../browserOwner/options';
import { createTerminalContext } from '../terminal/context';
import type { MediaFrame, MediaMeta, Surface } from './protocol';
import { createRemoteRenderer } from './renderer';

const size = { cols: 80, rows: 24, width: 1280, height: 720 };
const features = { keyboard: true, images: true, loadFrame: true, compositeFrame: true };
const settings: PaneSettings = {
  overlay: false,
  design: false,
  transparent: false,
  noPaint: false,
  debugPaint: false,
};

function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function meta(overrides: Partial<MediaMeta> = {}): MediaMeta {
  return {
    session: 's1',
    surface: 'content',
    generation: 1,
    epoch: 0,
    frame: 1,
    codec: 'png',
    width: 4,
    height: 3,
    x: 0,
    y: 0,
    z: 0,
    ...overrides,
  };
}

const renderers: ReturnType<typeof createRemoteRenderer>[] = [];
afterEach(() => {
  for (const renderer of renderers.splice(0)) renderer.dispose();
});

function setup(epoch = 0) {
  const writes: string[] = [];
  const credits: Surface[] = [];
  const terminal = createTerminalContext(
    'remote-renderer',
    size,
    features,
    (data) => writes.push(data),
    settings,
  );
  const renderer = createRemoteRenderer({
    terminal,
    epoch: () => epoch,
    credit: (surface) => credits.push(surface),
  });
  renderers.push(renderer);
  return {
    terminal,
    renderer,
    writes,
    credits,
    setEpoch: (value: number) => {
      epoch = value;
    },
  };
}

function frame(overrides: Partial<MediaMeta> = {}): MediaFrame {
  const payload = png(overrides.width ?? 4, overrides.height ?? 3);
  return { meta: meta(overrides), payload };
}

function fileFrom(command: string): { id: number; file: string } {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the protocol ESC framing
  const match = /\x1b_Gf=100,t=t,([^;]+);([A-Za-z0-9+/=]+)\x1b\\/.exec(command);
  if (!match) throw new Error(`No PNG transmit command: ${JSON.stringify(command)}`);
  const id = /(?:^|,)i=(\d+)/.exec(match[1] ?? '');
  return { id: Number(id?.[1]), file: Buffer.from(match[2] ?? '', 'base64').toString('utf8') };
}

describe('createRemoteRenderer', () => {
  test('writes a private PNG file and sends the f=100,t=t command', () => {
    const { renderer, writes } = setup();
    const frameData = frame({ x: 3, y: 2, z: 7, width: 5, height: 4 });
    renderer.render(frameData);

    const { id, file } = fileFrom(writes.join(''));
    const dir = path.dirname(file);
    expect(id).toBe(1);
    expect(path.isAbsolute(file)).toBe(true);
    expect(file.startsWith(os.tmpdir())).toBe(true);
    expect(file).toContain('tty-graphics-protocol');
    expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file)).toEqual(frameData.payload);
    expect(writes.join('')).toContain(
      `\x1b_Gf=100,t=t,s=5,v=4,a=T,q=0,C=1,i=1,X=0,Y=0,z=7;${Buffer.from(file).toString('base64')}\x1b\\`,
    );
    expect(writes.join('')).toContain('\x1b[2;3H');
  });

  test('returns credit only after the terminal acknowledges the image', () => {
    const { renderer, writes, credits } = setup();
    renderer.render(frame());

    const { id } = fileFrom(writes.join(''));
    expect(credits).toEqual([]);
    renderer.acknowledge(`i=${id},p=1`);
    expect(credits).toEqual(['content']);
    renderer.acknowledge(`i=${id},p=1`);
    expect(credits).toEqual(['content']);
  });

  test('composes matching toolbar and page with frame-specific credits', () => {
    const { renderer, writes, credits } = setup();
    renderer.render(frame());
    const first = fileFrom(writes.join(''));
    renderer.acknowledge(`i=${first.id};OK`);
    writes.length = 0;
    renderer.render(frame({ surface: 'toolbar', z: 1 }));
    const root = fileFrom(writes.join(''));
    expect(writes.join('')).toContain(`a=f,q=0,i=${root.id},r=3,X=1`);
    expect(writes.join('')).toContain(`a=c,q=1,C=0,i=${root.id},r=3,c=1`);
    renderer.acknowledge(`i=${root.id};OK`);
    expect(credits).toEqual(['content']);
    renderer.acknowledge(`i=${root.id},r=3;OK`);
    expect(credits).toEqual(['content', 'toolbar']);
    renderer.render(frame({ frame: 2 }));
    // The cached page was also uploaded during scene initialization. Its reply
    // may arrive after the first new page frame and must not consume its credit.
    renderer.acknowledge(`i=${root.id},r=2;OK`);
    expect(credits).toEqual(['content', 'toolbar']);
    renderer.acknowledge(`i=${root.id},r=3;OK`);
    expect(credits).toEqual(['content', 'toolbar']);
    renderer.acknowledge(`i=${root.id},r=2;OK`);
    expect(credits).toEqual(['content', 'toolbar', 'content']);
  });

  test('rebuilds a scene after resize without reusing the old toolbar raster', () => {
    const { renderer, writes, credits } = setup();
    renderer.render(frame());
    const initial = fileFrom(writes.join(''));
    renderer.acknowledge(`i=${initial.id};OK`);
    writes.length = 0;
    renderer.render(frame({ surface: 'toolbar', z: 1 }));
    const old = fileFrom(writes.join(''));
    renderer.acknowledge(`i=${old.id},r=2;OK`);
    renderer.acknowledge(`i=${old.id},r=3;OK`);
    writes.length = 0;
    renderer.render(frame({ width: 8, frame: 2 }));
    const resized = fileFrom(writes.join(''));
    expect(writes.join('')).toContain(`a=d,d=I,i=${old.id}`);
    expect(writes.join('')).not.toContain('a=c');
    renderer.acknowledge(`i=${resized.id};OK`);
    writes.length = 0;
    renderer.render(frame({ surface: 'toolbar', z: 1, width: 8, frame: 2 }));
    expect(writes.join('')).toContain('a=c,q=1,C=0');
    expect(credits).toEqual(['content', 'toolbar', 'content']);
  });

  test('drops a frame when canPaint is false', () => {
    const { terminal, renderer, writes, credits } = setup();
    const position = { x: { cell: 0, px: 0 }, y: { cell: 0, px: 0 } };
    for (let n = 0; n < 4; n++) {
      terminal.graphics.paintImage(
        { nameBase64: 'buffer' } as ShmGraphicBuffer,
        { width: 4, height: 3 },
        position,
      );
    }
    expect(terminal.canPaint()).toBe(false);
    writes.length = 0;

    renderer.render(frame());
    expect(writes).toEqual([]);
    expect(credits).toEqual(['content']);
  });

  test('a new epoch is not blocked by unacknowledged old uploads', () => {
    const { renderer, writes, credits, setEpoch } = setup();
    renderer.render(frame());
    const old = fileFrom(writes.join(''));
    setEpoch(1);
    writes.length = 0;
    renderer.render(frame({ epoch: 1 }));
    const current = fileFrom(writes.join(''));
    expect(current.id).not.toBe(old.id);
    renderer.acknowledge(`i=${old.id};OK`);
    expect(credits).toEqual([]);
    renderer.acknowledge(`i=${current.id};OK`);
    expect(credits).toEqual(['content']);
  });

  test('drops a frame from a stale epoch', () => {
    const { renderer, writes, credits } = setup(2);
    renderer.render(frame({ epoch: 1 }));
    expect(writes).toEqual([]);
    expect(credits).toEqual([]);
  });

  test('drops a payload that is not PNG or does not match the metadata', () => {
    const { renderer, writes, credits } = setup();
    renderer.render({ meta: meta(), payload: Buffer.from('not a png') });
    renderer.render({ meta: meta(), payload: png(6, 3) });
    expect(writes).toEqual([]);
    expect(credits).toEqual(['content', 'content']);
  });

  test('frees the previous image before painting the next frame', () => {
    const { renderer, writes } = setup();
    renderer.render(frame());
    const first = fileFrom(writes.join(''));
    renderer.acknowledge(`i=${first.id},p=1`);
    writes.length = 0;

    renderer.render(frame({ frame: 2 }));

    const all = writes.join('');
    const free = `\x1b_Ga=d,d=I,i=${first.id}\x1b\\`;
    const transmit = '\x1b_Gf=100';
    expect(all).toContain(free);
    expect(all).toContain(transmit);
    expect(all.indexOf(free)).toBeLessThan(all.indexOf(transmit));
  });

  test('frees the painted image on dispose', () => {
    const { renderer, writes } = setup();
    renderer.render(frame());
    const { id } = fileFrom(writes.join(''));
    writes.length = 0;

    renderer.dispose();

    expect(writes.join('')).toContain(`\x1b_Ga=d,d=I,i=${id}\x1b\\`);
  });

  test('removes the private directory on dispose', () => {
    const { renderer, writes } = setup();
    renderer.render(frame());
    const { file } = fileFrom(writes.join(''));
    const dir = path.dirname(file);
    expect(fs.existsSync(file)).toBe(true);

    renderer.dispose();
    expect(fs.existsSync(dir)).toBe(false);
  });
});
