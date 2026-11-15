import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCodePage, renderCodeTarget } from './codePage';

test('source pages escape code and expose stable line links and source identity', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awrit-code-'));
  try {
    const file = path.join(dir, 'example.ts');
    await fs.writeFile(file, 'const html = "<script>alert(1)</script>";\nsecond();\n');
    const page = await createCodePage(file, { outputRoot: path.join(dir, 'pages') });
    const html = await fs.readFile(page, 'utf8');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    // The viewport scrollbar follows <html>, not <body>.
    expect(html).toMatch(/html\{[^}]*color-scheme:dark/);
    expect(html).toContain('script-src \'none\'');
    expect(html).toContain('id="L2"');
    expect(html).toContain('href="#L2"');
    expect(html).toContain(file);
    expect(html).toMatch(/SHA-256: [a-f0-9]{64}/);
    expect(await fs.readFile(file, 'utf8')).toContain('<script>');
    expect(await renderCodeTarget(pathToFileURL(file).href)).toEndWith('index.html');
    expect(await renderCodeTarget(dir)).toBe(dir);
    expect(await renderCodeTarget('https://example.com/file.ts')).toBe('https://example.com/file.ts');
    expect(await renderCodeTarget(path.join(dir, 'missing.ts'))).toBe(path.join(dir, 'missing.ts'));
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('patch pages render old and new coordinates without executing changed text', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awrit-patch-'));
  try {
    const file = path.join(root, 'change.patch');
    await fs.writeFile(file, '@@ -4 +6 @@\n-<script>old</script>\n+<script>new</script>');
    const html = await fs.readFile(await createCodePage(file, { outputRoot: path.join(root, 'pages') }), 'utf8');
    expect(html).toContain('class="line removed"');
    expect(html).toContain('class="line added"');
    expect(html).toContain('aria-label="Old line">4</span>');
    expect(html).toContain('aria-label="New line">6</span>');
    expect(html).toContain('&lt;script&gt;new&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('source pages reject oversized and binary input', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awrit-code-'));
  try {
    const file = path.join(dir, 'example.ts');
    await fs.writeFile(file, Buffer.from([0, 1, 2]));
    await expect(createCodePage(file)).rejects.toThrow('binary');
    await fs.writeFile(file, '\n'.repeat(20000));
    await expect(createCodePage(file)).rejects.toThrow('20000 lines');
    await fs.writeFile(file, Buffer.from([0xff]));
    await expect(createCodePage(file)).rejects.toThrow();
    await fs.writeFile(file, 'x'.repeat(1024 * 1024 + 1));
    await expect(createCodePage(file)).rejects.toThrow('exceeds');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
