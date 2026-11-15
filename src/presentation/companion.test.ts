import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  companionLayoutCss,
  createCompanionHtmlFile,
  detectMediaType,
  escapeHtml,
  generateCompanionHtml,
  parseCompanionConfig,
  renderCompanionText,
  renderSimpleMarkdown,
  validatePresentationTarget,
  validatePresentationText,
} from './companion';

describe('companion presentation view', () => {
  describe('escapeHtml', () => {
    test('escapes HTML special characters', () => {
      expect(escapeHtml('<script>alert("xss" & \'test\')</script>')).toBe(
        '&lt;script&gt;alert(&quot;xss&quot; &amp; &#039;test&#039;)&lt;/script&gt;',
      );
    });
  });

  describe('validatePresentationText', () => {
    test('accepts valid text within 64 KiB with newlines and tabs', () => {
      const valid = 'Heading\nLine with\ttab and normal text.';
      expect(validatePresentationText(valid)).toBe(valid);
    });

    test('accepts text at exact 64 KiB boundary', () => {
      const maxText = 'a'.repeat(65536);
      expect(validatePresentationText(maxText)).toBe(maxText);
    });

    test('rejects text exceeding 64 KiB', () => {
      const overMax = 'a'.repeat(65537);
      expect(() => validatePresentationText(overMax)).toThrow(
        'Presentation text exceeds the 64 KiB limit',
      );
    });

    test('rejects non-string input', () => {
      expect(() => validatePresentationText(123 as unknown as string)).toThrow(
        'Presentation text must be a string',
      );
    });

    test('rejects C0 control characters except LF and TAB', () => {
      expect(() => validatePresentationText('bad\x00null')).toThrow(
        'Presentation text contains invalid control characters',
      );
      expect(() => validatePresentationText('bad\x07bell')).toThrow(
        'Presentation text contains invalid control characters',
      );
      expect(() => validatePresentationText('bad\x08backspace')).toThrow(
        'Presentation text contains invalid control characters',
      );
      expect(() => validatePresentationText('bad\x0bvt')).toThrow(
        'Presentation text contains invalid control characters',
      );
      expect(() => validatePresentationText('bad\x0cff')).toThrow(
        'Presentation text contains invalid control characters',
      );
      expect(() => validatePresentationText('bad\x1bescape')).toThrow(
        'Presentation text contains invalid control characters',
      );
      expect(() => validatePresentationText('bad\x7fdel')).toThrow(
        'Presentation text contains invalid control characters',
      );
    });

    test('rejects C1 control characters', () => {
      expect(() => validatePresentationText('bad\u0080c1')).toThrow(
        'Presentation text contains invalid control characters',
      );
      expect(() => validatePresentationText('bad\u009fc1')).toThrow(
        'Presentation text contains invalid control characters',
      );
    });
  });

  describe('validatePresentationTarget', () => {
    test('accepts valid file and web targets', () => {
      const fileTarget = {
        kind: 'file' as const,
        path: '/path/test.png',
        url: 'file:///path/test.png',
      };
      expect(validatePresentationTarget(fileTarget)).toBe(fileTarget);

      const webTarget = { kind: 'url' as const, url: 'https://example.com/page?query=1#sec' };
      expect(validatePresentationTarget(webTarget)).toBe(webTarget);
    });

    test('rejects targets with embedded credentials', () => {
      expect(() =>
        validatePresentationTarget({ kind: 'url', url: 'https://user:pass@example.com' }),
      ).toThrow('Target URL must not contain embedded credentials');
    });

    test('rejects targets with unsupported protocols', () => {
      expect(() => validatePresentationTarget({ kind: 'url', url: 'javascript:alert(1)' })).toThrow(
        'Web target must have http: or https: protocol',
      );
      expect(() =>
        validatePresentationTarget({ kind: 'url', url: 'ftp://example.com/file.txt' }),
      ).toThrow('Web target must have http: or https: protocol');
    });

    test('rejects targets with control characters', () => {
      expect(() =>
        validatePresentationTarget({ kind: 'url', url: 'https://example.com/\x00evil' }),
      ).toThrow('Target URL contains control characters');
      expect(() =>
        validatePresentationTarget({
          kind: 'file',
          path: '/path/\x1bevil',
          url: 'file:///path/evil',
        }),
      ).toThrow('Target path contains control characters');
    });

    test('rejects invalid or missing target properties', () => {
      expect(() =>
        validatePresentationTarget(null as unknown as { kind: 'url'; url: string }),
      ).toThrow('Target must be an object');
      expect(() =>
        validatePresentationTarget({
          kind: 'invalid' as unknown as 'url',
          url: 'https://example.com',
        }),
      ).toThrow('Target kind must be "file" or "url"');
      expect(() =>
        validatePresentationTarget({ kind: 'file', path: '', url: 'file:///test.png' }),
      ).toThrow('File target must have a valid path');
      expect(() =>
        validatePresentationTarget({ kind: 'file', path: '/test.png', url: 'http://example.com' }),
      ).toThrow('File target must have file: protocol');
    });
  });

  describe('parseCompanionConfig', () => {
    test('parses valid minimal JSON config', () => {
      const config = parseCompanionConfig(JSON.stringify({ text: 'Simple notes' }));
      expect(config).toEqual({ text: 'Simple notes' });
    });

    test('parses valid full JSON config with layout and columns', () => {
      const raw = JSON.stringify({
        text: 'Detailed notes',
        layout: 'media-left',
        columns: { text: 40, media: 60 },
      });
      const config = parseCompanionConfig(raw);
      expect(config).toEqual({
        text: 'Detailed notes',
        layout: 'media-left',
        columns: { text: 40, media: 60 },
      });
    });

    test('rejects non-string input', () => {
      expect(() => parseCompanionConfig(123 as unknown as string)).toThrow(
        'Companion config must be a string',
      );
    });

    test('rejects invalid JSON syntax', () => {
      expect(() => parseCompanionConfig('{ invalid: json')).toThrow('Invalid companion JSON');
    });

    test('rejects JSON arrays and primitives', () => {
      expect(() => parseCompanionConfig('["not", "an", "object"]')).toThrow(
        'Companion config must be an object',
      );
      expect(() => parseCompanionConfig('"just a string"')).toThrow(
        'Companion config must be an object',
      );
      expect(() => parseCompanionConfig('null')).toThrow('Companion config must be an object');
    });

    test('rejects unknown fields strictly', () => {
      const raw = JSON.stringify({ text: 'Notes', unexpected: true });
      expect(() => parseCompanionConfig(raw)).toThrow(
        'Unknown companion config property: unexpected',
      );
    });

    test('rejects missing or non-string text', () => {
      expect(() => parseCompanionConfig(JSON.stringify({ layout: 'text-left' }))).toThrow(
        'Companion config "text" must be a string',
      );
      expect(() => parseCompanionConfig(JSON.stringify({ text: 42 }))).toThrow(
        'Companion config "text" must be a string',
      );
    });

    test('validates text rules via validatePresentationText', () => {
      const hugeText = JSON.stringify({ text: 'a'.repeat(65537) });
      expect(() => parseCompanionConfig(hugeText)).toThrow(
        'Presentation text exceeds the 64 KiB limit',
      );

      const controlText = JSON.stringify({ text: 'bad\x00text' });
      expect(() => parseCompanionConfig(controlText)).toThrow(
        'Presentation text contains invalid control characters',
      );
    });

    test('rejects invalid layout values', () => {
      expect(() =>
        parseCompanionConfig(JSON.stringify({ text: 'Notes', layout: 'top-down' })),
      ).toThrow('Companion config "layout" must be "text-left" or "media-left"');
    });

    test('rejects invalid columns', () => {
      expect(() =>
        parseCompanionConfig(JSON.stringify({ text: 'Notes', columns: 'invalid' })),
      ).toThrow('Companion config "columns" must be an object');

      expect(() =>
        parseCompanionConfig(
          JSON.stringify({ text: 'Notes', columns: { text: 40, media: 60, extra: 10 } }),
        ),
      ).toThrow('Unknown companion columns property: extra');

      expect(() =>
        parseCompanionConfig(JSON.stringify({ text: 'Notes', columns: { text: 0, media: 100 } })),
      ).toThrow('Companion config columns must be integers between 1 and 1000');

      expect(() =>
        parseCompanionConfig(JSON.stringify({ text: 'Notes', columns: { text: 50, media: 1001 } })),
      ).toThrow('Companion config columns must be integers between 1 and 1000');
    });
  });

  describe('renderSimpleMarkdown', () => {
    test('renders headings, paragraphs, and inline formatting', () => {
      const md =
        '# Title\n## Subtitle\n### Section\nA paragraph with **bold** and *italic* and `code`.';
      const html = renderSimpleMarkdown(md);
      expect(html).toContain('<h1>Title</h1>');
      expect(html).toContain('<h2>Subtitle</h2>');
      expect(html).toContain('<h3>Section</h3>');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>italic</em>');
      expect(html).toContain('<code>code</code>');
    });

    test('escapes code without formatting inside inline code tokens', () => {
      const md = 'Code with `**bold inside code**` and `<script>alert("xss")</script>`.';
      const html = renderSimpleMarkdown(md);
      expect(html).toContain('<code>**bold inside code**</code>');
      expect(html).not.toContain('<strong>bold inside code</strong>');
      expect(html).toContain('<code>&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;</code>');
      expect(html).not.toContain('<script>');
    });

    test('renders code blocks and lists without formatting inside code blocks', () => {
      const md = '```typescript\nconst x = 1 < 2;\n**not bold**\n```\n- Item 1\n* Item 2';
      const html = renderSimpleMarkdown(md);
      expect(html).toContain(
        '<pre class="code-block"><code>const x = 1 &lt; 2;\n**not bold**</code></pre>',
      );
      expect(html).not.toContain('<strong>not bold</strong>');
      expect(html).toContain('<ul>');
      expect(html).toContain('<li>Item 1</li>');
      expect(html).toContain('<li>Item 2</li>');
      expect(html).toContain('</ul>');
    });

    test('handles unclosed code block and unclosed list at EOF', () => {
      const md = '```\nlet unclosed = true;';
      const html = renderSimpleMarkdown(md);
      expect(html).toContain('<pre class="code-block"><code>let unclosed = true;</code></pre>');

      const listMd = '- Open item';
      const listHtml = renderSimpleMarkdown(listMd);
      expect(listHtml).toContain('<ul>');
      expect(listHtml).toContain('<li>Open item</li>');
      expect(listHtml).toContain('</ul>');
    });
  });

  describe('detectMediaType', () => {
    test('classifies image, video, and web targets by normalized pathname extension', () => {
      expect(detectMediaType({ kind: 'file', path: '/a.png', url: 'file:///a.png' })).toBe('image');
      expect(detectMediaType({ kind: 'file', path: '/a.PNG', url: 'file:///a.PNG' })).toBe('image');
      expect(detectMediaType({ kind: 'file', path: '/a.jpg', url: 'file:///a.jpg' })).toBe('image');
      expect(detectMediaType({ kind: 'file', path: '/a.webp', url: 'file:///a.webp' })).toBe(
        'image',
      );
      expect(detectMediaType({ kind: 'file', path: '/v.mp4', url: 'file:///v.mp4' })).toBe('video');
      expect(detectMediaType({ kind: 'file', path: '/v.MP4', url: 'file:///v.MP4' })).toBe('video');
      expect(detectMediaType({ kind: 'file', path: '/v.webm', url: 'file:///v.webm' })).toBe(
        'video',
      );
      expect(detectMediaType({ kind: 'url', url: 'https://example.com' })).toBe('web');
      expect(detectMediaType({ kind: 'file', path: '/p.html', url: 'file:///p.html' })).toBe('web');
    });

    test('preserves valid fragments and avoids query/fragment extension confusion', () => {
      // Fragment with video timestamp preserved
      expect(detectMediaType({ kind: 'file', path: '/v.mp4', url: 'file:///v.mp4#t=10' })).toBe(
        'video',
      );
      // Fragment with .png does not make web target an image
      expect(
        detectMediaType({ kind: 'url', url: 'https://example.com/article.html#heading.png' }),
      ).toBe('web');
      // Query param with .jpg does not make web target an image
      expect(detectMediaType({ kind: 'url', url: 'https://example.com/?preview=test.jpg' })).toBe(
        'web',
      );
    });
  });

  describe('companionLayoutCss and renderCompanionText', () => {
    test('generates CSS with responsive flex rules and min-width 0', () => {
      const css = companionLayoutCss({ layout: 'text-left', columns: { text: 40, media: 60 } });
      expect(css).toContain('min-width: 0');
      expect(css).toContain('flex-direction: row');
      expect(css).toContain('flex: 40 1 0px');
      expect(css).toContain('flex: 60 1 0px');
      expect(css).toContain('overflow-x: hidden');
    });

    test('supports media-left with coherent narrow ordering', () => {
      const css = companionLayoutCss({ layout: 'media-left' });
      expect(css).toContain('flex-direction: row-reverse');
      expect(css).toContain('flex-direction: column-reverse');
    });

    test('renderCompanionText wraps rendered markdown notes', () => {
      const rendered = renderCompanionText({ text: '# Notes\nParagraph here.' });
      expect(rendered).toContain('<div class="text-pane">');
      expect(rendered).toContain('<h1>Notes</h1>');
      expect(rendered).toContain('<p>Paragraph here.</p>');
    });
  });

  describe('generateCompanionHtml', () => {
    test('generates complete HTML with text and image', () => {
      const html = generateCompanionHtml({
        text: '# Explanation\nHere is what was found.',
        target: { kind: 'file', path: '/test.png', url: 'file:///test.png' },
        layout: 'text-left',
      });
      expect(html).toContain('<!doctype html>');
      expect(html).toContain('Awrit Presentation Companion');
      expect(html).toContain('<div class="text-pane">');
      expect(html).toContain('<h1>Explanation</h1>');
      expect(html).toContain('<img src="file:///test.png"');
      expect(html).toContain('flex-direction: row');
    });

    test('renders video with controls only and no autoplay or loop', () => {
      const html = generateCompanionHtml({
        text: 'Video Notes',
        target: { kind: 'file', path: '/video.mp4', url: 'file:///video.mp4' },
      });
      expect(html).toContain(
        '<video src="file:///video.mp4" class="media-video" controls playsinline></video>',
      );
      expect(html).not.toContain('autoplay');
      expect(html).not.toContain('loop');
    });

    test('renders web iframe with restricted sandbox without same-origin', () => {
      const html = generateCompanionHtml({
        text: 'Web Notes',
        target: { kind: 'url', url: 'https://example.com' },
      });
      expect(html).toContain(
        '<iframe src="https://example.com" class="media-frame" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>',
      );
      expect(html).not.toContain('allow-same-origin');
      expect(html).not.toContain('allow-popups');
      expect(html).not.toContain('allow-top-navigation');
    });

    test('requires target parameter', () => {
      expect(() =>
        generateCompanionHtml({
          text: 'Notes without target',
        } as unknown as { target: { kind: 'url'; url: string }; text: string }),
      ).toThrow('Presentation target is required for companion view');
    });
  });

  describe('createCompanionHtmlFile', () => {
    test('creates secure temp file with 0600 mode and returns cleanup function', () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comp-test-scratch-'));
      try {
        const result = createCompanionHtmlFile(
          { text: 'Sample text', target: { kind: 'url', url: 'https://example.com' } },
          tempDir,
        );
        expect(result).toHaveProperty('filePath');
        expect(result).toHaveProperty('cleanup');
        expect(fs.existsSync(result.filePath)).toBe(true);

        const stat = fs.statSync(result.filePath);
        // Mode 0o600 on POSIX
        expect(stat.mode & 0o777).toBe(0o600);

        const content = fs.readFileSync(result.filePath, 'utf8');
        expect(content).toContain('Sample text');
        expect(content).toContain('https://example.com');

        // Test cleanup deletes the file and container directory
        result.cleanup();
        expect(fs.existsSync(result.filePath)).toBe(false);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    test('creates default private temp directory when scratchDir is omitted', () => {
      const result = createCompanionHtmlFile({
        text: 'Default temp notes',
        target: { kind: 'url', url: 'https://example.com' },
      });
      expect(fs.existsSync(result.filePath)).toBe(true);
      // Ensure it does not write into cwd/.tmp
      expect(result.filePath.startsWith(path.join(process.cwd(), '.tmp'))).toBe(false);
      result.cleanup();
      expect(fs.existsSync(result.filePath)).toBe(false);
    });
  });
});
