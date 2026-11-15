import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  acquireDeviceLock,
  cleanStaleDeviceLock,
  parseLockFile,
} from './androidManager.js';

describe('device lock', () => {
  let tmpDir: string;
  let origXdg: string | undefined;

  beforeEach(() => {
    origXdg = process.env.XDG_DATA_HOME;
    tmpDir = path.join(os.tmpdir(), `awrit-devlock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    process.env.XDG_DATA_HOME = tmpDir;
  });

  afterEach(() => {
    if (origXdg === undefined) {
      delete process.env.XDG_DATA_HOME;
    } else {
      process.env.XDG_DATA_HOME = origXdg;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('parseLockFile', () => {
    it('parses valid pid and token', () => {
      expect(parseLockFile('1234:abcdef')).toEqual({ pid: 1234, token: 'abcdef' });
      expect(parseLockFile('5678\n')).toEqual({ pid: 5678, token: undefined });
    });

    it('returns null on invalid input', () => {
      expect(parseLockFile('')).toBeNull();
      expect(parseLockFile('   \n')).toBeNull();
      expect(parseLockFile('notapid:token')).toBeNull();
      expect(parseLockFile('-5:token')).toBeNull();
      expect(parseLockFile('0:token')).toBeNull();
    });
  });

  it('exclusively locks: second acquisition fails, release allows third', () => {
    const dev = `dev-${Date.now()}-1`;
    const acq1 = acquireDeviceLock(dev);
    expect(acq1.ok).toBe(true);
    expect(acq1.handle).toBeDefined();

    const acq2 = acquireDeviceLock(dev);
    expect(acq2.ok).toBe(false);
    expect(acq2.message).toContain('already in progress');

    acq1.handle?.release();

    const acq3 = acquireDeviceLock(dev);
    expect(acq3.ok).toBe(true);
    expect(acq3.handle).toBeDefined();
    acq3.handle?.release();
  });

  it('release does not delete lock file if content replaced with different token', () => {
    const dev = `dev-${Date.now()}-2`;
    const acq1 = acquireDeviceLock(dev);
    expect(acq1.ok).toBe(true);
    if (!acq1.handle) throw new Error('Expected lock handle');
    const lockPath = acq1.handle.lockPath;

    // Overwrite with different token
    writeFileSync(lockPath, `${process.pid}:replaced-different-token\n`);

    acq1.handle.release();

    expect(existsSync(lockPath)).toBe(true);
    expect(readFileSync(lockPath, 'utf8')).toBe(`${process.pid}:replaced-different-token\n`);
  });

  it('returns false when lock path is a directory (fail path)', () => {
    const dev = `dev-${Date.now()}-3`;
    const lockPath = path.join(tmpDir, 'awrit', 'locks', `${dev}.lock`);
    mkdirSync(lockPath, { recursive: true });

    const acq = acquireDeviceLock(dev);
    expect(acq.ok).toBe(false);
  });

  it('cleans stale lock with dead pid and allows reacquisition', () => {
    const dev = `dev-${Date.now()}-4`;
    // Find an unused dead pid
    let deadPid = 999999;
    while (deadPid > 100000) {
      try {
        process.kill(deadPid, 0);
        deadPid--;
      } catch (e: unknown) {
        if ((e as { code?: string })?.code === 'ESRCH') break;
        deadPid--;
      }
    }

    const lockPath = path.join(tmpDir, 'awrit', 'locks', `${dev}.lock`);
    mkdirSync(path.dirname(lockPath), { recursive: true });
    writeFileSync(lockPath, `${deadPid}:deadtoken\n`);

    const cleaned = cleanStaleDeviceLock(dev);
    expect(cleaned).toBe(true);
    expect(existsSync(lockPath)).toBe(false);

    // Recreate dead lock and verify acquireDeviceLock auto-cleans stale lock on attempt 0
    writeFileSync(lockPath, `${deadPid}:deadtoken\n`);
    const acq = acquireDeviceLock(dev);
    expect(acq.ok).toBe(true);
    acq.handle?.release();
  });
});
