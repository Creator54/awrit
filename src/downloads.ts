import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Session } from 'electron';
import { console_ } from './console';

/** Returns `dir/name`, or `dir/name (n).ext` when that file already exists. */
export function uniqueDownloadPath(dir: string, filename: string, exists: (p: string) => boolean): string {
  const name = path.basename(filename) || 'download';
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let candidate = path.join(dir, name);
  for (let n = 1; exists(candidate); n++) {
    candidate = path.join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

/** Electron falls back to the home folder without XDG user dirs; Chrome uses ~/Downloads. */
export function downloadsFolder(electronPath: string, home = os.homedir()): string {
  return path.resolve(electronPath) === path.resolve(home) ? path.join(home, 'Downloads') : electronPath;
}

/** Saves page downloads to the system Downloads folder, as Chrome does by default. */
export function handleDownloads(session: Session, downloadsDir: string): void {
  // Paths still being written; two downloads started together must not share one.
  const pending = new Set<string>();
  session.on('will-download', (_event, item) => {
    fs.mkdirSync(downloadsDir, { recursive: true });
    const target = uniqueDownloadPath(downloadsDir, item.getFilename(), p => pending.has(p) || fs.existsSync(p));
    pending.add(target);
    item.setSavePath(target);
    item.once('done', (_e, state) => {
      pending.delete(target);
      console_.log(state === 'completed' ? `[Download] Saved ${target}` : `[Download] ${state}: ${target}`);
    });
  });
}
