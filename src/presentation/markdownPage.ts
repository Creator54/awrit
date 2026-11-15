import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { getAppDataPath } from '../paths';
import { escapeHtml } from './videoPage';

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
const MARKDOWN_EXT = /\.(md|markdown)$/i;
const PAGE_TTL_MS = 24 * 60 * 60 * 1000;

const STYLE = `body{background:#09090b;color:#e4e4e7;font:16px/1.6 system-ui,sans-serif;max-width:860px;margin:0 auto;padding:24px}
h1,h2,h3{color:#f4f4f5;line-height:1.25}a{color:#7dd3fc}img{max-width:100%}
code,pre{background:#18181b;border-radius:4px;font-family:ui-monospace,monospace}code{padding:1px 4px}
pre{padding:12px;overflow:auto}pre code{padding:0}blockquote{border-left:3px solid #3f3f46;margin:0;padding-left:12px;color:#a1a1aa}
table{border-collapse:collapse}th,td{border:1px solid #3f3f46;padding:4px 8px}`;

/** Local Markdown file path, or undefined for anything else (URLs, other files, missing files). */
export async function localMarkdownPath(target: string): Promise<string | undefined> {
  const candidate = /^file:/i.test(target) ? fileURLToPath(new URL(target)) : target;
  if (!MARKDOWN_EXT.test(candidate) || /^[a-z][a-z0-9+.-]*:/i.test(candidate))
    return undefined;
  try {
    const real = await fs.realpath(path.resolve(candidate));
    return (await fs.stat(real)).isFile() ? real : undefined;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Render a Markdown file as a script-free HTML page and return its path. */
export async function createMarkdownPage(
  file: string,
  options?: { outputRoot?: string },
): Promise<string> {
  const stat = await fs.stat(file);
  if (stat.size > MAX_MARKDOWN_BYTES)
    throw new Error(`Markdown file exceeds ${MAX_MARKDOWN_BYTES} bytes: ${stat.size}`);
  // Raw HTML in the source is shown as text, never interpreted.
  const converter = (globalThis as { Bun?: { markdown: typeof import('bun').markdown } }).Bun?.markdown;
  if (!converter) throw new Error('Markdown rendering needs the Bun-based awrit launcher');
  const source = await fs.readFile(file);
  if (source.byteLength > MAX_MARKDOWN_BYTES)
    throw new Error(`Markdown file exceeds ${MAX_MARKDOWN_BYTES} bytes: ${source.byteLength}`);
  const body = converter.html(source.toString('utf8'), {
    noHtmlBlocks: true,
    noHtmlSpans: true,
    tables: true,
    autolinks: true,
  });
  const base = escapeHtml(pathToFileURL(path.dirname(file) + path.sep).href);
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; img-src file: data:; style-src 'unsafe-inline';" />
<base href="${base}" />
<title>${escapeHtml(path.basename(file))}</title>
<style>${STYLE}</style></head>
<body>${body}</body></html>`;

  const root = options?.outputRoot ?? path.join(getAppDataPath(), 'markdown-pages');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^page-[a-zA-Z0-9]+$/.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      if ((await fs.stat(dir)).mtimeMs < Date.now() - PAGE_TTL_MS)
        await fs.rm(dir, { recursive: true, force: true });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  const dir = await fs.mkdtemp(path.join(root, 'page-'));
  const out = path.join(dir, 'index.html');
  await fs.writeFile(out, html, { mode: 0o600 });
  return out;
}

/** Replace a Markdown target with its rendered page; leave everything else unchanged. */
export async function renderMarkdownTarget(target: string): Promise<string> {
  const file = await localMarkdownPath(target);
  return file ? createMarkdownPage(file) : target;
}
