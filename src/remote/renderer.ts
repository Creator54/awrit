import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createTemporaryDirectory } from '../temporaryDirectory';
import path from 'node:path';
import type { TerminalContext } from '../terminal/context';
import type { MediaFrame, Surface } from './protocol';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_HEADER_END = 24;
// One black pixel at 60% opacity; Kitty scales it over the pane.
const SHADE_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGCYCQAAngCaQ/N96wAAAABJRU5ErkJggg==',
  'base64',
);
// Kitty's z is a signed 32-bit value; the shade stays above every remote frame.
const SHADE_Z = 2 ** 31 - 1;

export interface RemoteRendererDeps {
  terminal: TerminalContext;
  /** Current presentation epoch; frames from any other epoch are stale. */
  epoch: () => number;
  credit: (surface: Surface) => void;
}

export interface RemoteRenderer {
  render(frame: MediaFrame): void;
  acknowledge(id: string): void;
  /** Covers the pane with a translucent shade (a stale image) or removes it. */
  shade(cells: { cols: number; rows: number } | undefined): void;
  dispose(): void;
}

function validPng(payload: Buffer, width: number, height: number): boolean {
  return (
    payload.length >= PNG_HEADER_END &&
    payload.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
    payload.readUInt32BE(8) === 13 &&
    payload.toString('ascii', 12, 16) === 'IHDR' &&
    payload.readUInt32BE(16) === width &&
    payload.readUInt32BE(20) === height
  );
}

function imageNumber(id: string): number | undefined {
  const match = /(?:^|,)i=(\d+)(?:,|;|$)/.exec(id);
  return match ? Number(match[1]) : undefined;
}

/**
 * Client-side renderer for remote PNG frames. Frames go to the terminal as Kitty
 * `f=100,t=t` temp files, so nothing is decoded here. Credit is returned only
 * after the terminal acknowledges the image, and at most one frame per surface
 * is outstanding. Matching full-window page/toolbar surfaces share one paused
 * animation image so inactive-pane dimming cannot expose the page through UI.
 */
export function createRemoteRenderer(deps: RemoteRendererDeps): RemoteRenderer {
  const { terminal, epoch, credit } = deps;
  const directory = createTemporaryDirectory('tty-graphics-protocol-awrit-');
  const pending = new Map<string, Surface>();
  const initializationReplies = new Set<string>();
  const cached = new Map<Surface, MediaFrame>();
  let scene:
    | {
        image: ReturnType<typeof terminal.graphics.paintPngAnimation>;
        meta: MediaFrame['meta'];
        page: ReturnType<ReturnType<typeof terminal.graphics.paintPngAnimation>['loadFrameFile']>;
        toolbar: ReturnType<
          ReturnType<typeof terminal.graphics.paintPngAnimation>['loadFrameFile']
        >;
      }
    | undefined;
  const painted = new Map<Surface, ReturnType<typeof terminal.graphics.paintPngFile>>();
  let shadeHandle: ReturnType<typeof terminal.graphics.paintPngFile> | undefined;
  let disposed = false;
  let presentationEpoch = epoch();

  function synchronizeEpoch() {
    const current = epoch();
    if (current === presentationEpoch) return;
    presentationEpoch = current;
    scene?.image.free();
    scene = undefined;
    for (const handle of painted.values()) handle.free();
    painted.clear();
    cached.clear();
    pending.clear();
    initializationReplies.clear();
  }

  function writeFile(payload: Buffer): string {
    const file = path.join(directory, `tty-graphics-protocol-${randomUUID()}.png`);
    fs.writeFileSync(file, payload, { mode: 0o600, flag: 'wx' });
    return file;
  }

  function render(frame: MediaFrame) {
    if (disposed) return;
    const { meta, payload } = frame;
    if (meta.epoch !== epoch()) return;
    synchronizeEpoch();
    const unpaintable =
      meta.codec !== 'png' ||
      !terminal.canPaint() ||
      !validPng(payload, meta.width, meta.height) ||
      [...pending.values()].includes(meta.surface);
    if (unpaintable) {
      // The owner sends nothing more for this surface until its credit returns.
      credit(meta.surface);
      return;
    }
    cached.set(meta.surface, frame);
    const content = cached.get('content');
    const toolbar = cached.get('toolbar');
    const sameBounds = (a: MediaFrame['meta'], b: MediaFrame['meta']) =>
      a.width === b.width &&
      a.height === b.height &&
      a.x === b.x &&
      a.y === b.y &&
      a.epoch === b.epoch &&
      a.generation === b.generation;
    const compose =
      terminal.features.loadFrame &&
      terminal.features.compositeFrame &&
      content &&
      toolbar &&
      sameBounds(content.meta, toolbar.meta) &&
      content.meta.z === 0 &&
      toolbar.meta.z === 1;
    if (scene && (!compose || !sameBounds(scene.meta, meta))) {
      scene.image.free();
      scene = undefined;
    }
    if (compose) {
      if (!scene) {
        for (const handle of painted.values()) handle.free();
        painted.clear();
        // Finish fallible file writes before allocating the terminal image.
        const rootFile = writeFile(content.payload);
        const pageFile = writeFile(content.payload);
        const toolbarFile = writeFile(toolbar.payload);
        const image = terminal.graphics.paintPngAnimation(
          rootFile,
          { width: meta.width, height: meta.height },
          { x: { cell: meta.x, px: 0 }, y: { cell: meta.y, px: 0 } },
        );
        // The cached companion upload has no new surface credit to return.
        // Replies are ordered per frame slot, even if a later upload is queued.
        initializationReplies.add(`${image.id}:${meta.surface === 'content' ? 3 : 2}`);
        scene = {
          image,
          meta,
          page: image.loadFrameFile(2, pageFile, content.meta),
          toolbar: image.loadFrameFile(3, toolbarFile, toolbar.meta),
        };
      } else {
        const loaded = scene.image.loadFrameFile(
          meta.surface === 'content' ? 2 : 3,
          writeFile(payload),
          meta,
        );
        if (meta.surface === 'content') scene.page = loaded;
        else scene.toolbar = loaded;
      }
      const rect = { x: 0, y: 0, width: meta.width, height: meta.height };
      scene.page.composite(rect);
      scene.toolbar.composite(rect, true);
      pending.set(`${scene.image.id}:${meta.surface === 'content' ? 2 : 3}`, meta.surface);
      return;
    }
    const previous = painted.get(meta.surface);
    if (previous) previous.free();
    const handle = terminal.graphics.paintPngFile(
      writeFile(payload),
      { width: meta.width, height: meta.height },
      { x: { cell: meta.x, px: 0 }, y: { cell: meta.y, px: 0 } },
      { z: meta.z },
    );
    painted.set(meta.surface, handle);
    pending.set(`${handle.id}:0`, meta.surface);
  }

  function acknowledge(id: string) {
    if (disposed) return;
    synchronizeEpoch();
    terminal.acknowledgeGraphics(id);
    const number = imageNumber(id);
    if (number === undefined) return;
    const frame = /(?:^|,)r=(\d+)(?:,|;|$)/.exec(id);
    const key = `${number}:${frame ? Number(frame[1]) : 0}`;
    if (initializationReplies.delete(key)) return;
    const entry = pending.get(key);
    if (!entry) return;
    pending.delete(key);
    credit(entry);
  }

  function shade(cells: { cols: number; rows: number } | undefined) {
    if (disposed) return;
    shadeHandle?.free();
    shadeHandle = undefined;
    // c=0/r=0 would mean the image's natural 1px size.
    if (!cells || cells.cols < 1 || cells.rows < 1) return;
    shadeHandle = terminal.graphics.paintPngFile(
      writeFile(SHADE_PNG),
      { width: 1, height: 1 },
      { x: { cell: 0, px: 0 }, y: { cell: 0, px: 0 } },
      { z: SHADE_Z, cells },
    );
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    shadeHandle?.free();
    for (const handle of painted.values()) handle.free();
    scene?.image.free();
    scene = undefined;
    cached.clear();
    pending.clear();
    initializationReplies.clear();
    painted.clear();
    terminal.dispose();
    fs.rmSync(directory, { recursive: true, force: true });
  }

  return { render, acknowledge, shade, dispose };
}
