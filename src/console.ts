import fs from 'node:fs';
import path from 'node:path';

const LOG_FILE = path.join(process.cwd(), 'awrit-debug.log');

let logStream: fs.WriteStream | null = null;

function getLogStream() {
  if (!logStream) {
    // Clear log file on new session
    try {
      if (fs.existsSync(LOG_FILE)) {
        fs.unlinkSync(LOG_FILE);
      }
    } catch {}
    logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  }
  return logStream;
}

export const console_ = {
  ...console,
  error: (...args: unknown[]) => {
    const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] ${msg}\n`;
    
    // Write to file
    try {
      getLogStream().write(line);
    } catch {}
    
    // Also write to stderr
    process.stderr.write(line);
  },
  log: (...args: unknown[]) => {
    console_.error(...args);
  },
};

export function flushLogs() {
  if (logStream) {
    logStream.end();
    logStream = null;
  }
}
