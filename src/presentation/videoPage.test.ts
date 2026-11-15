import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MAX_INPUT_FILE_BYTES } from './video';
import { createVideoPage } from './videoPage';

describe('createVideoPage', () => {
  let tmpDir: string;
  let testVideoPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'awrit-video-page-test-'));
    testVideoPath = path.join(tmpDir, 'sample.mp4');
    await fs.writeFile(testVideoPath, Buffer.from('fake-video-content'));
  });

  afterEach(async () => {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('creates video page in outputRoot with mode 0600', async () => {
    const htmlPath = await createVideoPage(testVideoPath, 'hello world', { outputRoot: tmpDir });
    expect(htmlPath.startsWith(tmpDir)).toBe(true);

    const stat = await fs.stat(htmlPath);
    // mode & 0o777 should be 0o600
    expect(stat.mode & 0o777).toBe(0o600);

    const content = await fs.readFile(htmlPath, 'utf8');
    expect(content).toContain('<!doctype html>');
    expect(content).toContain('<title>recorded video</title>');
    expect(content).toContain('<div class="card-text">hello world</div>');
    expect(content).toContain('controls autoplay playsinline muted');
  });

  test('prunes only stale generated page directories', async () => {
    const stale = path.join(tmpDir, 'page-old');
    const recent = path.join(tmpDir, 'page-recent');
    const unrelated = path.join(tmpDir, 'keep');
    for (const dir of [stale, recent, unrelated]) await fs.mkdir(dir);
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    await fs.utimes(stale, old, old);
    await fs.utimes(unrelated, old, old);
    await createVideoPage(testVideoPath, undefined, { outputRoot: tmpDir });
    expect(await fs.readdir(tmpDir)).not.toContain('page-old');
    expect(await fs.readdir(tmpDir)).toContain('page-recent');
    expect(await fs.readdir(tmpDir)).toContain('keep');
  });

  test('escapes dangerous source path/name and text', async () => {
    const dangerousName = 'vid" onclick="alert(1)" <test>&.mp4';
    const dangerousPath = path.join(tmpDir, dangerousName);
    await fs.writeFile(dangerousPath, Buffer.from('video'));

    const dangerousText = '<script>alert("xss")</script> & "quotes" \'single\'';
    const htmlPath = await createVideoPage(dangerousPath, dangerousText, { outputRoot: tmpDir });
    const content = await fs.readFile(htmlPath, 'utf8');

    expect(content).not.toContain('<script>alert');
    expect(content.match(/<script/g)).toHaveLength(1);
    expect(content).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt; &amp; &quot;quotes&quot; &#039;single&#039;');
    expect(content).not.toContain('onclick="alert(1)"');
  });

  test('renders text as pre-wrap and not html', async () => {
    const multilineText = 'Line 1\nLine 2\n\tIndented';
    const htmlPath = await createVideoPage(testVideoPath, multilineText, { outputRoot: tmpDir });
    const content = await fs.readFile(htmlPath, 'utf8');
    expect(content).toContain('white-space: pre-wrap;');
    expect(content).toContain('Line 1\nLine 2\n\tIndented');
  });

  test('supports empty/undefined text gracefully', async () => {
    const htmlPath = await createVideoPage(testVideoPath, undefined, { outputRoot: tmpDir });
    const content = await fs.readFile(htmlPath, 'utf8');
    expect(content).not.toContain('class="card-text"');
    expect(content).toContain('<video src=');
  });

  test('enforces strict CSP with default-src none and file media', async () => {
    const htmlPath = await createVideoPage(testVideoPath, 'test', { outputRoot: tmpDir });
    const content = await fs.readFile(htmlPath, 'utf8');
    expect(content).toMatch(
      /content="default-src 'none'; media-src file:; style-src 'unsafe-inline'; script-src 'sha256-[A-Za-z0-9+/=]+';"/,
    );
    const script = content.match(/<script>(.*?)<\/script>/)?.[1] ?? '';
    const hash = createHash('sha256').update(script).digest('base64');
    expect(content).toContain(`script-src 'sha256-${hash}'`);
    expect(content).toContain('id="playback-error" hidden');
  });

  test('includes responsive card styling with stacked layout on small screens', async () => {
    const htmlPath = await createVideoPage(testVideoPath, 'test', { outputRoot: tmpDir });
    const content = await fs.readFile(htmlPath, 'utf8');
    expect(content).toContain('flex-direction: row;');
    expect(content).toContain('@media (max-width: 768px)');
    expect(content).toMatch(/\.card-text, \.card-video \{\s*flex: 0 0 auto;/);
    expect(content).toContain('flex-direction: column;');
  });

  test('rejects URLs and non-file sources', async () => {
    await expect(createVideoPage('https://example.com/video.mp4')).rejects.toThrow();
  });

  test('rejects non-video/unsupported extensions', async () => {
    const txtPath = path.join(tmpDir, 'doc.txt');
    await fs.writeFile(txtPath, 'text content');
    await expect(createVideoPage(txtPath)).rejects.toThrow('Unsupported video format');
    // Frame preparation can decode these, but native HTML video cannot play them reliably.
    for (const extension of ['gif', 'avi', 'mkv']) {
      const source = path.join(tmpDir, `recording.${extension}`);
      await fs.writeFile(source, 'media');
      await expect(createVideoPage(source)).rejects.toThrow('Unsupported video format');
    }
  });

  test('rejects non-existent file or directory source', async () => {
    await expect(createVideoPage(path.join(tmpDir, 'missing.mp4'))).rejects.toThrow();
    await expect(createVideoPage(tmpDir)).rejects.toThrow();
  });

  test('rejects oversize files exceeding MAX_INPUT_FILE_BYTES', async () => {
    const bigPath = path.join(tmpDir, 'big.mp4');
    const fh = await fs.open(bigPath, 'w');
    await fh.truncate(MAX_INPUT_FILE_BYTES + 1);
    await fh.close();

    await expect(createVideoPage(bigPath, undefined, { outputRoot: tmpDir })).rejects.toThrow(
      'exceeds maximum allowed size',
    );
  });

  test('rejects text containing control characters', async () => {
    await expect(
      createVideoPage(testVideoPath, 'bad\x00control', { outputRoot: tmpDir }),
    ).rejects.toThrow('Video page text contains invalid control characters');

    await expect(
      createVideoPage(testVideoPath, 'bad\x1bescape', { outputRoot: tmpDir }),
    ).rejects.toThrow('Video page text contains invalid control characters');
  });

  test('rejects text exceeding 64 KiB', async () => {
    const largeText = 'a'.repeat(64 * 1024 + 1);
    await expect(
      createVideoPage(testVideoPath, largeText, { outputRoot: tmpDir }),
    ).rejects.toThrow('exceeds the 65536 bytes limit');
  });

  test('omits the text column for blank text', async () => {
    const html = await fs.readFile(
      await createVideoPage(testVideoPath, '  \n ', { outputRoot: tmpDir }),
      'utf8',
    );
    expect(html).not.toContain('class="card-text"');
  });
});
