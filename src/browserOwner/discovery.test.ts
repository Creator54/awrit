import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('owner discovery survives different shell temporary directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-discovery-test-'));
  try {
    const runtime = path.join(root, 'runtime');
    fs.mkdirSync(runtime, { mode: 0o700 });
    const sockets = ['shell-a', 'shell-b'].map((shell) => {
      const temp = path.join(root, shell);
      fs.mkdirSync(temp);
      const result = Bun.spawnSync([
        process.execPath, '-e',
        `import { ownerSocketPath } from ${JSON.stringify(path.join(import.meta.dir, 'discovery.ts'))}; console.log(ownerSocketPath());`,
      ], { env: { ...process.env, TMPDIR: temp, XDG_RUNTIME_DIR: runtime, XDG_DATA_HOME: path.join(root, 'data') } });
      expect(result.exitCode).toBe(0);
      return result.stdout.toString().trim();
    });
    expect(sockets[0]).toBe(sockets[1]);
    expect(sockets[0].startsWith(runtime + path.sep)).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
