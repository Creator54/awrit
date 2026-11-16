import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { createMarkdownPage, localMarkdownPath, MAX_MARKDOWN_BYTES, renderMarkdownTarget } from './markdownPage';

const tmp = () => realpathSync(mkdtempSync(path.join(tmpdir(), 'awrit-md-')));

test('renders formatted markdown and never interprets raw HTML or scripts', async () => {
  const dir = tmp();
  const file = path.join(dir, 'a.md');
  writeFileSync(file, '# Title\n\n- one\n\n<script>alert(1)</script>\n\n<b>x</b>\n');
  const out = await createMarkdownPage(file, { outputRoot: path.join(dir, 'pages') });
  const html = readFileSync(out, 'utf8');
  expect(html).toContain('<h1>Title</h1>');
  expect(html).toContain('<li>one</li>');
  expect(html).not.toContain('<script>');
  expect(html).not.toContain('<b>x</b>');
  expect(html).toContain("default-src 'none'");
  expect(html).toContain("script-src 'none'");
  expect(statSync(out).mode & 0o777).toBe(0o600);
});

test('rejects oversized Markdown', async () => {
  const dir = tmp();
  const file = path.join(dir, 'large.md');
  writeFileSync(file, Buffer.alloc(MAX_MARKDOWN_BYTES + 1, 65));
  await expect(createMarkdownPage(file, { outputRoot: path.join(dir, 'pages') }))
    .rejects.toThrow('exceeds');
});

test('only existing local markdown files are converted', async () => {
  const dir = tmp();
  const md = path.join(dir, 'n.md');
  writeFileSync(md, '# n');
  writeFileSync(path.join(dir, 'n.txt'), 'x');
  expect(await localMarkdownPath(md)).toBeDefined();
  expect(await localMarkdownPath(pathToFileURL(md).href)).toBe(md);
  expect(await localMarkdownPath(path.join(dir, 'n.txt'))).toBeUndefined();
  expect(await localMarkdownPath(path.join(dir, 'missing.md'))).toBeUndefined();
  expect(await localMarkdownPath('https://example.com/r.md')).toBeUndefined();
  expect(await renderMarkdownTarget('https://example.com/r.md')).toBe('https://example.com/r.md');
});
