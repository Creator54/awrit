import { expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePresentationTarget } from './target';

test('local files canonicalize without becoming HTTPS hosts', () => {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'awrit-target-')));
  try {
    const file = path.join(dir, 'view ü #?.html');
    writeFileSync(file, '<p>Hello</p>');
    symlinkSync(file, path.join(dir, 'link.html'));
    for (const value of [file, 'view ü #?.html', 'link.html', pathToFileURL(file).href]) {
      expect(resolvePresentationTarget(value, dir)).toEqual({
        kind: 'file',
        path: file,
        url: pathToFileURL(file).href,
      });
    }
    expect(() => resolvePresentationTarget(dir)).toThrow('regular file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test('HTTP URLs preserve query values and reject schemes and credentials', () => {
  expect(resolvePresentationTarget('https://example.com/?x=a=b#fragment')).toEqual({
    kind: 'url',
    url: 'https://example.com/?x=a=b#fragment',
  });
  expect(resolvePresentationTarget('example.org')).toEqual({
    kind: 'url',
    url: 'https://example.org',
  });
  expect(resolvePresentationTarget('example.com:8080/path')).toEqual({
    kind: 'url',
    url: 'https://example.com:8080/path',
  });
  expect(resolvePresentationTarget('localhost:3000/app')).toEqual({
    kind: 'url',
    url: 'http://localhost:3000/app',
  });
  for (const address of ['127.0.0.1:8080', '[::1]:8080/app']) {
    expect(resolvePresentationTarget(address)).toEqual({ kind: 'url', url: `http://${address}` });
  }
  for (const value of [
    '',
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://example.com',
    'https://user:secret@example.com',
    'https://example.com/\n',
    'nonexistent.html',
    'missing-file.png',
    'script.py',
    './missing.html',
  ]) {
    expect(() => resolvePresentationTarget(value)).toThrow();
  }
});

test('unusable targets are argument misuse', async () => {
  const { UsageError } = await import('./usageError');
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-target-misuse-'));
  try {
    for (const value of [
      '',
      'ftp://example.com',
      'https://user:secret@example.com',
      path.join(dir, 'missing.html'),
      pathToFileURL(path.join(dir, 'missing.html')).href,
      'http://',
      dir,
    ]) {
      expect(() => resolvePresentationTarget(value)).toThrow(UsageError);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
