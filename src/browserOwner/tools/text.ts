import type { WebContents } from 'electron';

// Worst case is 3 bytes per char in UTF-8: 15k text + two 2k fields = 57 KB, under the 64 KB tool output limit.
export const MAX_TEXT_CHARS = 15_000;
export const MAX_FIELD_CHARS = 2_000;

/** Bounds a page-controlled field (URL, title) so it cannot push the reply past the output limit. */
export const clipField = (value: string): string => value.slice(0, MAX_FIELD_CHARS);

export interface PageText {
  text: string;
  truncated?: true;
}

/** Reads the page's visible text, as a person would see it. */
export async function readPageText(wc: Pick<WebContents, 'executeJavaScript'>): Promise<PageText> {
  const raw: unknown = await wc.executeJavaScript(
    'document.body ? document.body.innerText : ""',
    false,
  );
  const text = typeof raw === 'string' ? raw : '';
  return text.length > MAX_TEXT_CHARS
    ? { text: text.slice(0, MAX_TEXT_CHARS), truncated: true }
    : { text };
}
