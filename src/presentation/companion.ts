import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTemporaryDirectory } from '../temporaryDirectory';
import type { ColumnSplit, PresentationLayout } from './args';
import type { PresentationTarget } from './target';

export interface CompanionConfig {
  text: string;
  layout?: PresentationLayout;
  columns?: ColumnSplit;
}

export interface CompanionViewOptions extends CompanionConfig {
  target: PresentationTarget;
}

export interface CompanionHtmlFileResult {
  filePath: string;
  cleanup: () => void;
}

export function validatePresentationText(text: string): string {
  if (typeof text !== 'string') {
    throw new Error('Presentation text must be a string');
  }
  if (Buffer.byteLength(text, 'utf8') > 65536) {
    throw new Error('Presentation text exceeds the 64 KiB limit');
  }
  // Reject C0 controls except LF (0x0a) and TAB (0x09), DEL (0x7f), and C1 controls (0x80-0x9f)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject C0 (except LF, TAB) and C1 control characters
  if (/[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/.test(text)) {
    throw new Error('Presentation text contains invalid control characters');
  }
  return text;
}

export function validatePresentationTarget(target: PresentationTarget): PresentationTarget {
  if (!target || typeof target !== 'object') {
    throw new Error('Target must be an object');
  }
  if (target.kind !== 'file' && target.kind !== 'url') {
    throw new Error('Target kind must be "file" or "url"');
  }
  if (typeof target.url !== 'string' || !target.url) {
    throw new Error('Target URL must be a non-empty string');
  }
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in target URL
  if (/[\x00-\x1f\x7f]/.test(target.url)) {
    throw new Error('Target URL contains control characters');
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(target.url);
  } catch {
    throw new Error(`Target URL is not a valid URL: ${target.url}`);
  }
  if (parsedUrl.username || parsedUrl.password) {
    throw new Error('Target URL must not contain embedded credentials');
  }
  if (target.kind === 'file') {
    if (parsedUrl.protocol !== 'file:') {
      throw new Error(`File target must have file: protocol, got ${parsedUrl.protocol}`);
    }
    if (typeof target.path !== 'string' || !target.path) {
      throw new Error('File target must have a valid path');
    }
    // biome-ignore lint/suspicious/noControlCharactersInRegex: reject control characters in target path
    if (/[\x00-\x1f\x7f]/.test(target.path)) {
      throw new Error('Target path contains control characters');
    }
  } else if (target.kind === 'url') {
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error(`Web target must have http: or https: protocol, got ${parsedUrl.protocol}`);
    }
  }
  return target;
}

export function parseCompanionConfig(raw: string): CompanionConfig {
  if (typeof raw !== 'string') {
    throw new Error('Companion config must be a string');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Invalid companion JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Companion config must be an object');
  }
  const obj = parsed as Record<string, unknown>;
  const allowedKeys = new Set(['text', 'layout', 'columns']);
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`Unknown companion config property: ${key}`);
    }
  }
  if (typeof obj.text !== 'string') {
    throw new Error('Companion config "text" must be a string');
  }
  const text = validatePresentationText(obj.text);
  let layout: PresentationLayout | undefined;
  if (obj.layout !== undefined) {
    if (obj.layout !== 'text-left' && obj.layout !== 'media-left') {
      throw new Error('Companion config "layout" must be "text-left" or "media-left"');
    }
    layout = obj.layout;
  }
  let columns: ColumnSplit | undefined;
  if (obj.columns !== undefined) {
    if (!obj.columns || typeof obj.columns !== 'object' || Array.isArray(obj.columns)) {
      throw new Error('Companion config "columns" must be an object');
    }
    const colObj = obj.columns as Record<string, unknown>;
    for (const key of Object.keys(colObj)) {
      if (key !== 'text' && key !== 'media') {
        throw new Error(`Unknown companion columns property: ${key}`);
      }
    }
    const textCols = colObj.text;
    const mediaCols = colObj.media;
    if (
      typeof textCols !== 'number' ||
      typeof mediaCols !== 'number' ||
      !Number.isSafeInteger(textCols) ||
      !Number.isSafeInteger(mediaCols) ||
      textCols < 1 ||
      mediaCols < 1 ||
      textCols > 1000 ||
      mediaCols > 1000
    ) {
      throw new Error('Companion config columns must be integers between 1 and 1000');
    }
    columns = { text: textCols, media: mediaCols };
  }
  return {
    text,
    ...(layout !== undefined ? { layout } : {}),
    ...(columns !== undefined ? { columns } : {}),
  };
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatInline(text: string): string {
  const parts = text.split(/(`[^`]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith('`') && part.endsWith('`') && part.length >= 2) {
        const codeContent = part.slice(1, -1);
        return `<code>${escapeHtml(codeContent)}</code>`;
      }
      let escaped = escapeHtml(part);
      escaped = escaped.replace(/\*\*\*([^*]+)\*\*\*/g, '<strong><em>$1</em></strong>');
      escaped = escaped.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      escaped = escaped.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      return escaped;
    })
    .join('');
}

export function renderSimpleMarkdown(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const htmlOut: string[] = [];
  let inCodeBlock = false;
  let codeBuffer: string[] = [];
  let inList = false;

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        htmlOut.push(
          `<pre class="code-block"><code>${codeBuffer.map(escapeHtml).join('\n')}</code></pre>`,
        );
        codeBuffer = [];
        inCodeBlock = false;
      } else {
        if (inList) {
          htmlOut.push('</ul>');
          inList = false;
        }
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeBuffer.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) {
        htmlOut.push('</ul>');
        inList = false;
      }
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (headingMatch) {
      if (inList) {
        htmlOut.push('</ul>');
        inList = false;
      }
      const level = headingMatch[1].length;
      htmlOut.push(`<h${level}>${formatInline(headingMatch[2])}</h${level}>`);
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inList) {
        htmlOut.push('<ul>');
        inList = true;
      }
      htmlOut.push(`<li>${formatInline(trimmed.slice(2))}</li>`);
    } else {
      if (inList) {
        htmlOut.push('</ul>');
        inList = false;
      }
      htmlOut.push(`<p>${formatInline(trimmed)}</p>`);
    }
  }

  if (inCodeBlock) {
    htmlOut.push(
      `<pre class="code-block"><code>${codeBuffer.map(escapeHtml).join('\n')}</code></pre>`,
    );
  }
  if (inList) {
    htmlOut.push('</ul>');
  }

  return htmlOut.join('\n');
}

export function detectMediaType(target: PresentationTarget): 'image' | 'video' | 'web' {
  validatePresentationTarget(target);
  const parsed = new URL(target.url);
  const pathname = parsed.pathname.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(pathname)) {
    return 'image';
  }
  if (/\.(mp4|webm|mkv|mov|avi|ogv)$/i.test(pathname)) {
    return 'video';
  }
  return 'web';
}

export function companionLayoutCss(config?: Pick<CompanionConfig, 'layout' | 'columns'>): string {
  const isMediaLeft = config?.layout === 'media-left';
  const textRatio = config?.columns ? config.columns.text : 45;
  const mediaRatio = config?.columns ? config.columns.media : 55;

  return `
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      height: 100%;
      width: 100%;
      background-color: #121214;
      color: #e4e4e7;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      overflow-x: hidden;
      overflow-y: hidden;
    }
    .companion-container {
      display: flex;
      flex-direction: ${isMediaLeft ? 'row-reverse' : 'row'};
      height: 100vh;
      width: 100vw;
      min-width: 0;
      overflow: hidden;
    }
    .text-pane {
      flex: ${textRatio} 1 0px;
      min-width: 0;
      height: 100%;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 24px;
      border-right: ${isMediaLeft ? 'none' : '1px solid #27272a'};
      border-left: ${isMediaLeft ? '1px solid #27272a' : 'none'};
      line-height: 1.6;
      word-break: break-word;
      overflow-wrap: break-word;
    }
    .media-pane {
      flex: ${mediaRatio} 1 0px;
      min-width: 0;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
      background-color: #09090b;
      overflow: hidden;
      position: relative;
    }
    .text-pane h1, .text-pane h2, .text-pane h3,
    .text-pane h4, .text-pane h5, .text-pane h6 {
      color: #fafafa;
      margin-top: 16px;
      margin-bottom: 8px;
    }
    .text-pane h1:first-child, .text-pane h2:first-child, .text-pane h3:first-child {
      margin-top: 0;
    }
    .text-pane p {
      margin-bottom: 12px;
    }
    .text-pane ul {
      margin-left: 20px;
      margin-bottom: 12px;
    }
    .text-pane li {
      margin-bottom: 4px;
    }
    .text-pane code {
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      background-color: #27272a;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 0.9em;
    }
    .text-pane pre.code-block {
      background-color: #18181b;
      border: 1px solid #27272a;
      border-radius: 6px;
      padding: 12px;
      margin-bottom: 12px;
      overflow-x: auto;
      min-width: 0;
    }
    .text-pane pre.code-block code {
      background: none;
      padding: 0;
    }
    .media-image {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
    .media-video {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
    }
    .media-frame {
      width: 100%;
      height: 100%;
      border: none;
    }
    .empty-media {
      color: #71717a;
      font-style: italic;
    }

    @media (max-width: 600px) {
      .companion-container {
        flex-direction: ${isMediaLeft ? 'column-reverse' : 'column'};
      }
      .text-pane {
        flex: ${textRatio} 1 0px;
        width: 100%;
        min-width: 0;
        max-width: 100%;
        min-height: 0;
        height: auto;
        padding: min(24px, 5vh) 16px;
        border-left: none;
        border-right: none;
        border-bottom: ${isMediaLeft ? 'none' : '1px solid #27272a'};
        border-top: ${isMediaLeft ? '1px solid #27272a' : 'none'};
      }
      .media-pane {
        flex: ${mediaRatio} 1 0px;
        width: 100%;
        min-width: 0;
        min-height: 0;
        height: auto;
      }
    }
  `;
}

export function renderCompanionText(config: Pick<CompanionConfig, 'text'>): string {
  const validatedText = validatePresentationText(config.text);
  const rendered = renderSimpleMarkdown(validatedText);
  return `<div class="text-pane">\n${rendered}\n</div>`;
}

export function generateCompanionHtml(options: CompanionViewOptions): string {
  if (!options.target) {
    throw new Error('Presentation target is required for companion view');
  }

  const validatedTarget = validatePresentationTarget(options.target);
  const textHtml = renderCompanionText(options);
  const mediaType = detectMediaType(validatedTarget);

  let mediaHtml = '';
  if (mediaType === 'image') {
    mediaHtml = `<img src="${escapeHtml(validatedTarget.url)}" class="media-image" alt="Preview target" />`;
  } else if (mediaType === 'video') {
    mediaHtml = `<video src="${escapeHtml(validatedTarget.url)}" class="media-video" controls playsinline></video>`;
  } else {
    // Web targets: denied same-origin, denied popups, denied top-level navigation
    // Note: Framing restrictions (X-Frame-Options or CSP frame-ancestors) on target sites may prevent framing.
    mediaHtml = `<iframe src="${escapeHtml(validatedTarget.url)}" class="media-frame" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>`;
  }

  const css = companionLayoutCss(options);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Referrer-Policy" content="no-referrer" />
  <title>Awrit Presentation Companion</title>
  <style>${css}</style>
</head>
<body>
  <div class="companion-container">
    ${textHtml}
    <div class="media-pane">
      ${mediaHtml}
    </div>
  </div>
</body>
</html>`;
}

export function createCompanionHtmlFile(
  options: CompanionViewOptions,
  scratchDir?: string,
): CompanionHtmlFileResult {
  const html = generateCompanionHtml(options);
  const baseDir = scratchDir ? path.resolve(scratchDir) : os.tmpdir();
  if (!fs.existsSync(baseDir)) {
    fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 });
  }
  const tempDir = createTemporaryDirectory('awrit-companion-', baseDir);
  const filePath = path.join(tempDir, 'index.html');
  try {
    fs.writeFileSync(filePath, html, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  };

  return { filePath, cleanup };
}
