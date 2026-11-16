import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { getAppDataPath, getLogPath } from './paths';

describe('paths', () => {
  test('getAppDataPath returns valid path under user data directory', () => {
    const appData = getAppDataPath();
    expect(typeof appData).toBe('string');
    expect(appData.endsWith('awrit')).toBe(true);
    expect(appData).not.toBe(process.cwd());
  });

  test('getLogPath returns awrit.log inside appData path', () => {
    const logPath = getLogPath();
    expect(logPath.endsWith(path.join('awrit', 'awrit.log'))).toBe(true);
  });
});
