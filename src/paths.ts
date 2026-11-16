import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Returns the application data directory. XDG_DATA_HOME wins on every OS when set.
 * Linux: ~/.local/share/awrit
 * macOS: ~/Library/Application Support/awrit
 * Windows: %LOCALAPPDATA%/awrit
 */
export function getAppDataPath() {
  const home = os.homedir();
  let appData: string;

  if (process.env.XDG_DATA_HOME) {
    appData = process.env.XDG_DATA_HOME;
  } else if (process.platform === 'win32') {
    appData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  } else if (process.platform === 'darwin') {
    appData = path.join(home, 'Library', 'Application Support');
  } else {
    // Linux/Unix fallback
    appData = path.join(home, '.local', 'share');
  }

  const p = path.join(appData, 'awrit');

  // Ensure the directory exists
  if (!fs.existsSync(p)) {
    fs.mkdirSync(p, { recursive: true });
  }

  return p;
}

/**
 * Returns the absolute path to the main log file.
 */
export function getLogPath() {
  return path.join(getAppDataPath(), 'awrit.log');
}
