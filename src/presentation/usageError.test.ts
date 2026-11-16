import { expect, spyOn, test } from 'bun:test';
import { reportCliError, UsageError } from './usageError';

function capture() {
  const writes: string[] = [];
  const stdout = spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  const stderr = spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    writes.push(String(chunk));
    return true;
  });
  return {
    writes,
    restore() {
      stdout.mockRestore();
      stderr.mockRestore();
    },
  };
}

test('misuse exits 2 and runtime failures exit 1', () => {
  const out = capture();
  try {
    expect(reportCliError(new UsageError('bad flag'), false)).toBe(2);
    expect(out.writes.join('')).toBe('awrit: bad flag\n');
    expect(reportCliError(new Error('viewer is down'), false)).toBe(1);
  } finally {
    out.restore();
  }
});

test('JSON mode reports the error on stdout', () => {
  const out = capture();
  try {
    expect(reportCliError(new UsageError('bad flag'), true)).toBe(2);
    expect(JSON.parse(out.writes.join(''))).toEqual({ error: 'bad flag' });
    expect(reportCliError('plain string', true)).toBe(1);
  } finally {
    out.restore();
  }
});
