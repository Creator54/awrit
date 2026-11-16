import type { WindowView } from '../windows';
import { withoutAgentPreview } from './tools/preview';

export interface PageCapture {
  png: Buffer;
  url: string;
  /** PNG pixel size. */
  width: number;
  height: number;
  /** Backing content size when captured; differs from the PNG on HiDPI screens. */
  inputWidth: number;
  inputHeight: number;
}

export interface PageCaptureOptions {
  waitMs?: number;
  waitSelector?: string;
}

/** Waits for the page to settle, then captures its visible frame once. */
export async function capturePagePng(
  view: WindowView,
  options: PageCaptureOptions = {},
): Promise<PageCapture> {
  const wc = view.content.webContents;

  // 1. Wait for active loading to finish (bounded to 3s)
  if (wc.isLoading()) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 3000);
      wc.once('did-stop-loading', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  // 2. Explicit wait selector or delay if provided
  if (typeof options.waitSelector === 'string' && options.waitSelector.trim()) {
    const selector = JSON.stringify(options.waitSelector.trim());
    const start = Date.now();
    while (Date.now() - start < 5000) {
      try {
        if (await wc.executeJavaScript(`Boolean(document.querySelector(${selector}))`, true)) break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const waitMs = options.waitMs;
  if (typeof waitMs === 'number' && waitMs > 0 && waitMs <= 30000) {
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  // 3. Flush frame render passes
  try {
    await wc.executeJavaScript(
      `new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))`,
      true,
    );
  } catch {}

  const [inputWidth, inputHeight] = view.content.getContentSize();
  // Screenshots must show the page, not the agent's cursor.
  const image = await withoutAgentPreview(wc, () => wc.capturePage());
  const [finalWidth, finalHeight] = view.content.getContentSize();
  if (inputWidth !== finalWidth || inputHeight !== finalHeight)
    throw new Error('Viewer resized during capture; capture again');

  const { width, height } = image.getSize();
  return { png: image.toPNG(), url: wc.getURL(), width, height, inputWidth, inputHeight };
}
