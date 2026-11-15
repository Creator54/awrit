import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type TemporaryPrefix = 'awrit-companion-' | 'tty-graphics-protocol-awrit-';

/** Recover only same-user directories owned by a process that no longer exists.
 * Root must be a temporary workspace where this application owns prefix-tagged
 * directories. A reused PID delays cleanup; legacy names are preserved.
 */
export function createTemporaryDirectory(prefix: TemporaryPrefix, root = os.tmpdir()): string {
  const uid = process.getuid?.();
  if (uid !== undefined) {
    let names: string[] = [];
    try { names = fs.readdirSync(root); } catch { /* Recovery is best-effort. */ }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const match = /^(\d+)-[A-Za-z0-9]{6}$/.exec(name.slice(prefix.length));
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
      try {
        process.kill(pid, 0);
        continue;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) continue;
      }
      const directory = path.join(root, name);
      try {
        const stat = fs.lstatSync(directory);
        if (stat.isDirectory() && stat.uid === uid) fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        // An inaccessible or concurrently removed entry must not block creation.
      }
    }
  }
  const directory = fs.mkdtempSync(path.join(root, `${prefix}${process.pid}-`));
  fs.chmodSync(directory, 0o700);
  return directory;
}
