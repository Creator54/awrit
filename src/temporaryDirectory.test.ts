import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTemporaryDirectory } from './temporaryDirectory';

for (const prefix of ['awrit-companion-', 'tty-graphics-protocol-awrit-'] as const) {
  test(`${prefix} recovers a killed child without touching live or unfamiliar directories`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-recovery-test-'));
    const module = path.join(import.meta.dir, 'temporaryDirectory.ts');
    const child = Bun.spawn([process.execPath, '-e', `import { createTemporaryDirectory } from ${JSON.stringify(module)}; const d=createTemporaryDirectory(${JSON.stringify(prefix)},${JSON.stringify(root)}); console.log(d); setInterval(()=>{},1000);`], { stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = child.stdout.getReader();
      const chunk = await reader.read();
      reader.releaseLock();
      if (!chunk.value) throw new Error('Child exited before creating its directory');
      const abandoned = Buffer.from(chunk.value).toString().trim();
      expect(fs.existsSync(abandoned)).toBe(true);
      const live = createTemporaryDirectory(prefix, root);
      expect(fs.existsSync(abandoned)).toBe(true);
      const foreign = path.join(root, `${prefix}legacy`);
      fs.mkdirSync(foreign);
      const target = path.join(root, 'keep');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'evidence'), 'keep');
      child.kill('SIGKILL');
      await child.exited;
      const link = path.join(root, `${prefix}${child.pid}-ABC123`);
      fs.symlinkSync(target, link);
      const next = createTemporaryDirectory(prefix, root);
      expect(fs.existsSync(abandoned)).toBe(false);
      for (const entry of [live, foreign, target, link, next]) expect(fs.existsSync(entry)).toBe(true);
      expect(fs.readFileSync(path.join(target, 'evidence'), 'utf8')).toBe('keep');
      const before = fs.readdirSync(root).sort();
      for (let i = 0; i < 50; i++) {
        const directory = createTemporaryDirectory(prefix, root);
        fs.writeFileSync(path.join(directory, 'frame.png'), Buffer.alloc(1024));
        fs.rmSync(directory, { recursive: true });
      }
      expect(fs.readdirSync(root).sort()).toEqual(before);
    } finally {
      child.kill();
      await child.exited;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10000);
}
