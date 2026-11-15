import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { appendLogLine, formatLogArgs } from './console';

test('errors log their message, not {}', () => {
  const line = formatLogArgs(['Failed:', new Error('disk full'), { a: 1 }]);
  expect(line).toContain('Failed: Error: disk full');
  expect(line).toContain('{"a":1}');
});

test('log stays bounded across repeated writes and oversized messages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-log-'));
  const file = path.join(dir, 'awrit.log');
  try {
    fs.writeFileSync(file, 'old'.repeat(100));
    appendLogLine(file, 'latest\n', 32);
    expect(fs.readFileSync(file, 'utf8')).toBe('latest\n');
    for (let i = 0; i < 100; i++) appendLogLine(file, `line ${i}\n`, 32);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(32);
    expect(fs.readFileSync(file, 'utf8')).toContain('line 99');
    appendLogLine(file, 'x'.repeat(200), 32);
    expect(fs.statSync(file).size).toBe(32);
    appendLogLine(file, 'next\n', 32);
    expect(fs.readFileSync(file, 'utf8')).toBe('next\n');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
