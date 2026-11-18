import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('macOS owner socket fits the Unix socket path limit with a long TMPDIR', () => {
  // Keep the host's data and owner sockets out of this subprocess's lookup.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-darwin-discovery-test-'));
  const temp = path.join(root, 'private', 'var', 'folders', 'ab', 'x'.repeat(32), 'T');
  fs.mkdirSync(temp, { recursive: true });
  const data = path.join(root, 'data');
  try {
    const result = Bun.spawnSync([
      process.execPath, '-e',
      `Object.defineProperty(process, 'platform', { value: 'darwin' });
       const { ownerSocketPath } = await import(${JSON.stringify(path.join(import.meta.dir, 'discovery.ts'))});
       console.log(ownerSocketPath());`,
    ], { env: { ...process.env, TMPDIR: temp, XDG_RUNTIME_DIR: '', XDG_DATA_HOME: data } });
    expect(result.exitCode).toBe(0);
    expect(Buffer.byteLength(result.stdout.toString().trim())).toBeLessThan(104);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    const identity = createHash('sha256').update(path.join(data, 'awrit')).digest('hex').slice(0, 20);
    const fallback = path.join('/tmp', `awrit-owner-${process.getuid?.()}-${identity}`);
    if (fs.existsSync(fallback)) fs.rmdirSync(fallback);
  }
});

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
