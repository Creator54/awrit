import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAppDataPath } from '../paths';
import { escapeHtml } from './videoPage';
import { mapDiffLines } from './diffLines';

const MAX_SOURCE_BYTES = 1024 * 1024;
const SOURCE_EXT = /\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|kts|c|h|cpp|hpp|cs|rb|php|sh|bash|zsh|fish|nix|css|scss|json|toml|ya?ml|xml|sql|diff|patch|txt)$/i;

/** A read-only, script-free source snapshot. Never executes source or fetches assets. */
export async function createCodePage(file: string, options?: { outputRoot?: string }): Promise<string> {
  const sourcePath = await fs.realpath(file);
  if ((await fs.stat(sourcePath)).size > MAX_SOURCE_BYTES) throw new Error('Source file exceeds 1 MiB');
  const bytes = await fs.readFile(sourcePath);
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('Source file exceeds 1 MiB');
  if (bytes.includes(0)) throw new Error('Cannot display binary source');
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const sourceLines = source.split('\n');
  if (sourceLines.length > 20000) throw new Error('Source file exceeds 20000 lines');
  const isDiff = /\.(diff|patch)$/i.test(sourcePath);
  const diffRows = isDiff ? mapDiffLines(sourceLines) : undefined;
  const lines = sourceLines.map((line, index) => {
    const n = index + 1;
    const row = diffRows?.[index];
    const coordinates = row ? `<span class="coordinate" aria-label="Old line">${row.oldLine ?? ''}</span><span class="coordinate" aria-label="New line">${row.newLine ?? ''}</span>` : '';
    return `<div class="line ${row?.kind ?? ''}" id="L${n}"><a href="#L${n}" aria-label="${isDiff ? 'Patch line' : 'Line'} ${n}">${n}</a>${coordinates}<code>${escapeHtml(line) || ' '}</code></div>`;
  }).join('');
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; object-src 'none'; style-src 'unsafe-inline'">
<title>${escapeHtml(path.basename(sourcePath))}</title><style>
html{color-scheme:dark;background:#141419}
body{margin:0;background:#141419;color:#fbfbfe;font:13px/1.6 ui-monospace,monospace;color-scheme:dark}
header{padding:16px;border-bottom:1px solid #444;overflow-wrap:anywhere}small{color:#aaa}
main{padding:12px 0;min-width:max-content}.line{display:flex;content-visibility:auto;contain-intrinsic-size:auto 21px}
.line:target{background:#26364d}.line a{color:#aaa;text-align:right;min-width:5ch;padding:0 16px;text-decoration:none;user-select:none}
.coordinate{color:#aaa;min-width:5ch;text-align:right;padding-right:12px;user-select:none}.added{background:#153127}.removed{background:#3b2025}.meta{color:#a6c9f5}
.line a:focus-visible{outline:2px solid #7dd3fc}code{white-space:pre;padding-right:16px}
</style></head><body><header>${escapeHtml(sourcePath)}<br><small>Read-only snapshot · SHA-256: ${hash}</small></header><main>${lines}</main></body></html>`;
  const root = options?.outputRoot ?? path.join(getAppDataPath(), 'code-pages');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^page-[a-zA-Z0-9]+$/.test(entry.name)) continue;
    const dir = path.join(root, entry.name);
    try {
      if ((await fs.stat(dir)).mtimeMs < Date.now() - 24 * 60 * 60 * 1000) {
        await fs.rm(dir, { recursive: true, force: true });
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  const dir = await fs.mkdtemp(path.join(root, 'page-'));
  const out = path.join(dir, 'index.html');
  await fs.writeFile(path.join(dir, 'source.json'), JSON.stringify({ path: sourcePath, sha256: hash }), { mode: 0o600 });
  await fs.writeFile(path.join(dir, 'source.txt'), bytes, { mode: 0o600 });
  await fs.writeFile(out, html, { mode: 0o600 });
  return out;
}

export async function renderCodeTarget(target: string): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^file:/i.test(target)) return target;
  const candidate = /^file:/i.test(target) ? fileURLToPath(new URL(target)) : target;
  if (!SOURCE_EXT.test(candidate)) return target;
  try {
    if (!(await fs.stat(candidate)).isFile()) return target;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return target;
    throw error;
  }
  return createCodePage(candidate);
}
