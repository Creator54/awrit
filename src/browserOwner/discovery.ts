import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getAppDataPath } from '../paths';

export function ownerSocketPath(): string {
  const identity = createHash('sha256').update(getAppDataPath()).digest('hex').slice(0, 20);
  const directory = path.join(
    process.env.XDG_RUNTIME_DIR || os.tmpdir(),
    `awrit-owner-${process.getuid?.() ?? os.userInfo().username}-${identity}`,
  );
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  const stat = fs.lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  ) {
    throw new Error('Unsafe Awrit owner directory');
  }
  return path.join(directory, 'terminal.sock');
}
