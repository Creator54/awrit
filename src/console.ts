import fs from 'node:fs';
import { getLogPath } from './paths';

const LOG_FILE = getLogPath();

const MAX_LOG_BYTES = 10 * 1024 * 1024;

/** Truncate in place so other Awrit processes cannot keep writing a rotated inode. */
export function appendLogLine(file: string, line: string, maxBytes = MAX_LOG_BYTES): void {
  const data = Buffer.from(line);
  const bounded = data.length > maxBytes ? data.subarray(0, maxBytes) : data;
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    if (fs.fstatSync(fd).size + bounded.length > maxBytes) fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, bounded);
  } finally {
    fs.closeSync(fd);
  }
}

/** JSON.stringify drops an Error's own fields and logs `{}`, so errors log their stack. */
export function formatLogArgs(args: unknown[]): string {
  return args
    .map((a) =>
      a instanceof Error
        ? (a.stack ?? String(a))
        : typeof a === 'object'
          ? JSON.stringify(a)
          : String(a),
    )
    .join(' ');
}

export const console_ = {
  ...console,
  error: (...args: unknown[]) => {
    const msg = formatLogArgs(args);
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;

    // Write to file
    try {
      appendLogLine(LOG_FILE, line);
    } catch {}
  },
  log: (...args: unknown[]) => {
    console_.error(...args);
  },
};
