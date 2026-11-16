import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  cleanupCurrentSession,
  getCurrentSession,
  getRuntimeRoot,
  initSessionWorkspace,
  pruneDeadSessions,
} from './workspace';

describe('session workspace', () => {
  const testRoot = path.join(os.tmpdir(), `awrit-session-test-${Date.now()}`);

  beforeEach(() => {
    process.env.AWRIT_RUNTIME_DIR = testRoot;
    fs.mkdirSync(testRoot, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    cleanupCurrentSession();
    try {
      if (fs.existsSync(testRoot)) {
        fs.rmSync(testRoot, { recursive: true, force: true });
      }
    } catch {}
    delete process.env.AWRIT_RUNTIME_DIR;
  });

  test('creates session workspace with 0700 mode in runtime root', () => {
    const session = initSessionWorkspace();
    expect(session.sessionId).toMatch(/^sess-\d+-[a-f0-9]+$/);
    expect(fs.existsSync(session.dir)).toBe(true);

    const stat = fs.statSync(session.dir);
    // Mode should be 0700
    expect(stat.mode & 0o777).toBe(0o700);
    expect(getCurrentSession()).toBe(session);
  });

  test('cleans up session workspace cleanly on request', () => {
    const session = initSessionWorkspace();
    expect(fs.existsSync(session.dir)).toBe(true);

    cleanupCurrentSession();
    expect(fs.existsSync(session.dir)).toBe(false);
    expect(getCurrentSession()).toBeNull();
  });

  test('prunes dead session directories using PID check', () => {
    const root = getRuntimeRoot();
    const sessionsDir = path.join(root, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });

    // Create an orphaned session with an impossible/dead PID
    const deadPid = 9999999;
    const deadDir = path.join(sessionsDir, `sess-${deadPid}-dead1234`);
    fs.mkdirSync(deadDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(deadDir, 'capture.png'), 'fake-png');

    // Also create an active session with our own PID
    const active = initSessionWorkspace();

    const pruned = pruneDeadSessions();
    expect(pruned).toBe(1);
    expect(fs.existsSync(deadDir)).toBe(false);
    expect(fs.existsSync(active.dir)).toBe(true);
  });
});
