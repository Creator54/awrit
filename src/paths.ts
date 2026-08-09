import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Returns the platform-specific application data directory.
 * Linux: ~/.local/share/awrit
 * macOS: ~/Library/Application Support/awrit
 * Windows: %LOCALAPPDATA%/awrit
 */
export function getAppDataPath() {
  const home = os.homedir();
  let appData: string;

  if (process.platform === 'win32') {
    appData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  } else if (process.platform === 'darwin') {
    appData = path.join(home, 'Library', 'Application Support');
  } else {
    // Linux/Unix fallback
    appData = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  }

  const p = path.join(appData, 'awrit');

  // Ensure the directory exists
  try {
    if (!fs.existsSync(p)) {
      fs.mkdirSync(p, { recursive: true });
    }
  } catch (_err) {
    // Fallback to current directory if we can't create the app data path
    // (unlikely but safe for a CLI tool)
    return process.cwd();
  }

  return p;
}

/**
 * Returns the absolute path to the main log file.
 */
export function getLogPath() {
  return path.join(getAppDataPath(), 'awrit.log');
}
