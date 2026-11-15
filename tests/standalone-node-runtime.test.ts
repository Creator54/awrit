import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyNodeRuntime } from '../packaging/nodeRuntime';

test('ships the Node executable and license, not development tools', () => {
  const root = mkdtempSync(join(tmpdir(), 'awrit-node-runtime-'));
  try {
    const source = join(root, 'source'); const destination = join(root, 'output');
    for (const name of ['bin/node', 'bin/npm', 'include/node/header.h', 'lib/node_modules/npm/index.js', 'LICENSE']) {
      mkdirSync(join(source, name, '..'), { recursive: true });
      writeFileSync(join(source, name), name);
    }
    copyNodeRuntime(source, destination);
    expect(readFileSync(join(destination, 'bin/node'), 'utf8')).toBe('bin/node');
    expect(readFileSync(join(destination, 'LICENSE'), 'utf8')).toBe('LICENSE');
    for (const name of ['bin/npm', 'include', 'lib']) expect(existsSync(join(destination, name))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
