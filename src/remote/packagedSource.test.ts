import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPackagedSource } from './packagedSource';

test('packaged source verifies exact bytes and uses content-specific runtime identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'awrit-source-test-'));
  try {
    const bytes = Buffer.from('explicit fixture archive');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const manifest = { format: 1, version: '2.0.5', size: bytes.length, sha256 };
    const save = (value: unknown) =>
      writeFileSync(join(dir, 'manifest.json'), JSON.stringify(value));
    writeFileSync(join(dir, 'source.tar'), bytes);
    save(manifest);
    expect(readPackagedSource(dir)).toEqual({ version: `2.0.5-s${sha256.slice(0, 24)}`, bytes });
    for (const invalid of [
      null,
      [],
      { ...manifest, extra: true },
      { ...manifest, format: 2 },
      { ...manifest, size: -1 },
      { ...manifest, size: 67108865 },
      { ...manifest, version: '../bad' },
      { ...manifest, sha256: 'A'.repeat(64) },
    ]) {
      save(invalid);
      expect(() => readPackagedSource(dir)).toThrow('Invalid remote source manifest');
    }
    save({ ...manifest, size: bytes.length + 1 });
    expect(() => readPackagedSource(dir)).toThrow('does not match');
    save({ ...manifest, sha256: '0'.repeat(64) });
    expect(() => readPackagedSource(dir)).toThrow('does not match');
    writeFileSync(join(dir, 'manifest.json'), ' '.repeat(4097));
    expect(() => readPackagedSource(dir)).toThrow('too large or not regular');
    save(manifest);
    writeFileSync(join(dir, 'source.tar'), Buffer.alloc(bytes.length + 1));
    expect(() => readPackagedSource(dir)).toThrow('too large or not regular');
    writeFileSync(join(dir, 'source.tar'), Buffer.alloc(bytes.length));
    expect(() => readPackagedSource(dir)).toThrow('does not match');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
