import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SessionWorkspace {
  sessionId: string;
  dir: string;
  pid: number;
}

let currentSession: SessionWorkspace | null = null;

/**
 * Resolves the root directory for ephemeral Awrit runtime files.
 * Prefers $XDG_RUNTIME_DIR (RAM tmpfs, mode 0700).
 * Falls back to /tmp/awrit-<uid> with strict mode 0700 and symlink checks.
 */
export function getRuntimeRoot(): string {
  if (process.env.AWRIT_RUNTIME_DIR) {
    return process.env.AWRIT_RUNTIME_DIR;
  }

  if (process.env.XDG_RUNTIME_DIR) {
    const runtimeDir = path.join(process.env.XDG_RUNTIME_DIR, 'awrit');
    if (!fs.existsSync(runtimeDir)) {
      fs.mkdirSync(runtimeDir, { recursive: true, mode: 0o700 });
    }
    try {
      fs.chmodSync(runtimeDir, 0o700);
    } catch {}
    return runtimeDir;
  }

  const uid = typeof process.getuid === 'function' ? process.getuid() : os.userInfo?.()?.uid ?? 'default';
  const fallbackDir = path.join(os.tmpdir(), `awrit-${uid}`);

  if (fs.existsSync(fallbackDir)) {
    try {
      const stat = fs.lstatSync(fallbackDir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        fs.unlinkSync(fallbackDir);
        fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
      }
    } catch {
      // ignore stat errors, attempt mkdir
    }
  } else {
    fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o700 });
  }

  try {
    fs.chmodSync(fallbackDir, 0o700);
  } catch {}

  return fallbackDir;
}

/**
 * Creates or gets the current active ephemeral session workspace.
 */
export function initSessionWorkspace(pid: number = process.pid): SessionWorkspace {
  if (currentSession && fs.existsSync(currentSession.dir)) {
    return currentSession;
  }

  const root = getRuntimeRoot();
  const sessionsDir = path.join(root, 'sessions');
  if (!fs.existsSync(sessionsDir)) {
    fs.mkdirSync(sessionsDir, { recursive: true, mode: 0o700 });
  }

  const token = crypto.randomBytes(4).toString('hex');
  const sessionId = `sess-${pid}-${token}`;
  const dir = path.join(sessionsDir, sessionId);

  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  currentSession = { sessionId, dir, pid };
  return currentSession;
}

export function getCurrentSession(): SessionWorkspace | null {
  return currentSession;
}

/**
 * Cleans up the current session workspace directory.
 */
export function cleanupCurrentSession(): void {
  if (!currentSession) return;
  try {
    if (fs.existsSync(currentSession.dir)) {
      fs.rmSync(currentSession.dir, { recursive: true, force: true });
    }
  } catch {}
  currentSession = null;
}

/**
 * Checks if a given PID is currently alive on the system.
 */
function isPidAlive(pid: number): boolean {
  if (pid <= 0 || !Number.isInteger(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e.code === 'EPERM'; // Alive but owned by someone else or insufficient perms
  }
}

/**
 * Sweeps dead session directories left behind by crashed viewer processes.
 * Uses PID liveness check (`process.kill(pid, 0)`).
 */
export function pruneDeadSessions(): number {
  const root = getRuntimeRoot();
  const sessionsDir = path.join(root, 'sessions');
  if (!fs.existsSync(sessionsDir)) return 0;

  let pruned = 0;
  try {
    const entries = fs.readdirSync(sessionsDir);
    for (const name of entries) {
      // Format: sess-<pid>-<token>
      const match = /^sess-(\d+)-[a-f0-9]+$/.exec(name);
      if (!match) continue;

      const pid = parseInt(match[1], 10);
      const sessionPath = path.join(sessionsDir, name);

      // Never prune our own currently running session
      if (currentSession && currentSession.sessionId === name) {
        continue;
      }

      if (!isPidAlive(pid)) {
        try {
          fs.rmSync(sessionPath, { recursive: true, force: true });
          pruned++;
        } catch {}
      }
    }
  } catch {}

  return pruned;
}
