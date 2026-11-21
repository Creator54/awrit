import path from 'node:path';
import fs from 'node:fs';

/** A Kitty window id, or a TUIOS pane id when the review covers one pane inside TUIOS. */
export const TERMINAL_ID = /^(?:[1-9][0-9]{0,9}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

export function terminalReviewTarget(windowId: string, imagePath: string): string {
  const target = `awrit://terminal-review/${windowId}?image=${encodeURIComponent(imagePath)}`;
  parseTerminalReviewTarget(target);
  return target;
}

export function readTerminalCapture(imagePath: string): Buffer {
  const fd = fs.openSync(imagePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 24 || stat.size > 20 * 1024 * 1024 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw new Error('Invalid terminal capture file');
    const png = fs.readFileSync(fd);
    if (!png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      throw new Error('Invalid terminal capture PNG');
    }
    return png;
  } finally { fs.closeSync(fd); }
}

/** Internal local handoff, never a navigable web page. */
export function parseTerminalReviewTarget(target: string): { windowId: string; imagePath: string } | undefined {
  if (!target.startsWith('awrit://terminal-review')) return undefined;
  const url = new URL(target);
  const windowId = url.pathname.slice(1);
  const imagePath = url.searchParams.get('image') ?? '';
  if (url.hostname !== 'terminal-review' || url.username || url.password || url.port || url.hash ||
      !TERMINAL_ID.test(windowId) || !path.isAbsolute(imagePath) || imagePath.includes('\0') ||
      [...url.searchParams.keys()].length !== 1 || url.searchParams.getAll('image').length !== 1) {
    throw new Error('Invalid terminal review target');
  }
  return { windowId, imagePath };
}
