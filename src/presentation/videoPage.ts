import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAppDataPath } from '../paths';
import { MAX_INPUT_FILE_BYTES } from './video';
import { resolvePresentationTarget } from './target';

export const MAX_VIDEO_PAGE_TEXT_BYTES = 64 * 1024; // 64 KiB

export interface CreateVideoPageOptions {
  outputRoot?: string;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function validateVideoPageText(text?: string): string | undefined {
  if (text === undefined) return undefined;
  if (typeof text !== 'string') {
    throw new Error('Video page text must be a string');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_VIDEO_PAGE_TEXT_BYTES) {
    throw new Error(`Video page text exceeds the ${MAX_VIDEO_PAGE_TEXT_BYTES} bytes limit`);
  }
  // Reject C0 controls except LF (0x0a) and TAB (0x09), DEL (0x7f), and C1 controls (0x80-0x9f)
  // biome-ignore lint/suspicious/noControlCharactersInRegex: reject C0 (except LF, TAB) and C1 control characters
  if (/[\x00-\x08\x0b-\x1f\x7f\u0080-\u009f]/.test(text)) {
    throw new Error('Video page text contains invalid control characters');
  }
  // Blank text would reserve an empty column beside the video.
  return text.trim() === '' ? undefined : text;
}

export async function createVideoPage(
  source: string,
  text?: string,
  options?: CreateVideoPageOptions,
): Promise<string> {
  if (!source || typeof source !== 'string') {
    throw new Error('Video source must be a non-empty string');
  }

  const validatedText = validateVideoPageText(text);

  const resolved = resolvePresentationTarget(source);
  if (resolved.kind !== 'file') {
    throw new Error('Video source must be a local regular file');
  }

  const ext = path.extname(resolved.path).toLowerCase();
  if (!new Set(['.mp4', '.mov', '.m4v', '.webm']).has(ext)) {
    throw new Error(`Unsupported video format: ${ext}`);
  }

  const stat = await fs.stat(resolved.path);
  if (!stat.isFile()) {
    throw new Error('Video source must be a regular file');
  }
  if (stat.size > MAX_INPUT_FILE_BYTES) {
    throw new Error(
      `Video file exceeds maximum allowed size of ${MAX_INPUT_FILE_BYTES} bytes: ${stat.size} bytes`,
    );
  }

  const fileUrl = pathToFileURL(resolved.path).href;
  const escapedVideoSrc = escapeHtml(fileUrl);
  const textSection = validatedText !== undefined
    ? `<div class="card-text">${escapeHtml(validatedText)}</div>`
    : '';

  // An unplayable codec otherwise leaves a black box with no explanation.
  const errorScript =
    "const v=document.querySelector('video');v.addEventListener('error',()=>{document.getElementById('playback-error').hidden=false;});";
  const scriptHash = createHash('sha256').update(errorScript).digest('base64');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; media-src file:; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}';" />
  <title>recorded video</title>
  <style>
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    html, body {
      min-height: 100vh;
      width: 100%;
      background-color: #09090b;
      color: #f4f4f5;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 16px;
    }
    .video-card {
      background-color: #18181b;
      border: 1px solid #27272a;
      border-radius: 8px;
      padding: 16px;
      width: 100%;
      max-width: 1100px;
      display: flex;
      flex-direction: row;
      gap: 16px;
      align-items: stretch;
    }
    .card-text {
      flex: 1 1 0px;
      min-width: 0;
      white-space: pre-wrap;
      word-break: break-word;
      overflow-wrap: break-word;
      line-height: 1.5;
      color: #e4e4e7;
      font-size: 0.95rem;
      align-self: center;
    }
    .card-video {
      flex: 1 1 0px;
      min-width: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      background-color: #000;
      border-radius: 6px;
      overflow: hidden;
    }
    .card-video video {
      width: 100%;
      height: auto;
      max-height: 80vh;
      display: block;
      object-fit: contain;
    }
    #playback-error {
      padding: 12px;
      color: #fca5a5;
      font-size: 0.9rem;
    }
    @media (max-width: 768px) {
      .video-card {
        flex-direction: column;
      }
      /* The row basis of 0 would collapse these to zero height in a column. */
      .card-text, .card-video {
        flex: 0 0 auto;
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="video-card">
    ${textSection}
    <div class="card-video">
      <video src="${escapedVideoSrc}" controls autoplay playsinline muted></video>
      <p id="playback-error" hidden>This recording cannot be played here. Its codec may be unsupported; try an H.264 MP4 or WebM.</p>
    </div>
    <script>${errorScript}</script>
  </div>
</body>
</html>`;

  const baseDir = options?.outputRoot ?? path.join(getAppDataPath(), 'video-pages');
  await fs.mkdir(baseDir, { recursive: true, mode: 0o700 });

  // Retain recent pages for overlay reopen, but do not accumulate old explanations forever.
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const entry of await fs.readdir(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^page-[a-zA-Z0-9]+$/.test(entry.name)) continue;
    const candidate = path.join(baseDir, entry.name);
    try {
      if ((await fs.stat(candidate)).mtimeMs < cutoff)
        await fs.rm(candidate, { recursive: true, force: true });
    } catch (error) {
      // Another launch may have removed the same stale page.
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  const tempDir = await fs.mkdtemp(path.join(baseDir, 'page-'));
  const htmlPath = path.join(tempDir, 'index.html');
  await fs.writeFile(htmlPath, html, { mode: 0o600 });

  return htmlPath;
}
