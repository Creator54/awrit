import fs from 'node:fs';
import { getLogPath } from './paths';

const LOG_FILE = getLogPath();

let logStream: fs.WriteStream | null = null;

function getLogStream() {
  if (!logStream) {
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  }
  return logStream;
}

export const console_ = {
  ...console,
  error: (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;

    // Write to file
    try {
      getLogStream().write(line);
    } catch {}
  },
  log: (...args: unknown[]) => {
    console_.error(...args);
  },
};

/**
 * Redirects all global console and stderr output to the log file.
 * This prevents log pollution from breaking the TUI / Kitty graphics.
 */
export function setupLogging() {
  // Redirect global console
  console.log = (...args) => console_.log(...args);
  console.error = (...args) => console_.error(...args);

  // Redirect stderr (catches Electron logs, etc.)
  process.stderr.write = ((data: string | Uint8Array) => {
    getLogStream().write(data);
    return true;
  }) as any;
}

export function flushLogs() {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}
