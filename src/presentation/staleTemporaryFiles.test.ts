import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDraftsDir, pruneDrafts } from '../design/draftStore';
import { getCapturesDir, pruneOldCaptures } from './collaborativeCapture';

for (const kind of ['capture', 'draft'] as const) {
  test(`${kind} pruning removes only stale owned regular temporary files`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-stale-'));
    const original = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = root;
    try {
      const dir = kind === 'capture' ? getCapturesDir() : getDraftsDir();
      const name = kind === 'capture' ? 'cap-12345678.png' : 'draft-12345678.json';
      const stale = path.join(dir, `${name}.12345678.tmp`);
      const fresh = path.join(dir, `${name}.abcdef12.tmp`);
      const foreign = path.join(dir, 'notes.tmp');
      const directory = path.join(dir, `${name}.abcdef13.tmp`);
      const link = path.join(dir, `${name}.abcdef14.tmp`);
      const saved = path.join(dir, kind === 'capture' ? 'cap-12345678.png' : 'user.json');
      for (const file of [stale, fresh, foreign, saved]) fs.writeFileSync(file, 'keep');
      const old = new Date(Date.now() - 7200_000);
      for (const file of [stale, foreign, saved]) fs.utimesSync(file, old, old);
      fs.mkdirSync(directory);
      fs.utimesSync(directory, old, old);
      fs.symlinkSync(saved, link);
      if (kind === 'capture') {
        const snapshot = path.join(dir, 'cap-12345678.tmp-snap.png');
        fs.writeFileSync(snapshot, 'stale');
        fs.utimesSync(snapshot, old, old);
        pruneOldCaptures();
        expect(fs.existsSync(snapshot)).toBe(false);
      } else pruneDrafts({ width: 100, height: 100 });
      expect(fs.existsSync(stale)).toBe(false);
      for (const file of [fresh, foreign, directory, link, saved]) expect(fs.existsSync(file)).toBe(true);
    } finally {
      if (original === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = original;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
