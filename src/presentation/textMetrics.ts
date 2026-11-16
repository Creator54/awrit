export const graphemeSegmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

// biome-ignore lint/suspicious/noControlCharactersInRegex: necessary for terminal control sequences
const ANSI_ESCAPE_REGEX = /\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: necessary for terminal control sequences
const C0_CONTROL_REGEX = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
const C1_CONTROL_REGEX = /[\u0080-\u009f]/g;

export function sanitizeTerminalText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '  ')
    .replace(ANSI_ESCAPE_REGEX, '') // Strip ANSI escape sequences
    .replace(C0_CONTROL_REGEX, '') // Strip C0 control characters
    .replace(C1_CONTROL_REGEX, ''); // Strip C1 control characters
}

export function getGraphemeWidth(grapheme: string): number {
  if (!grapheme) return 0;
  const cp = grapheme.codePointAt(0);
  if (cp === undefined) return 0;
  // C0 and C1 controls
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return 0;
  // Zero-width characters & formatting
  if (
    (cp >= 0x200b && cp <= 0x200f) ||
    cp === 0xfeff ||
    cp === 0x00ad ||
    cp === 0x200c ||
    cp === 0x200d
  ) {
    return 0;
  }
  if (/^\p{M}+$/u.test(grapheme)) return 0;
  // Emoji / Extended_Pictographic
  if (/\p{Extended_Pictographic}/u.test(grapheme)) {
    if (grapheme.includes('︎')) return 1;
    return 2;
  }
  // East Asian Wide / Fullwidth characters (CJK, Hiragana, Katakana, Hangul, Fullwidth variants)
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2329 && cp <= 0x232a) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe10 && cp <= 0xfe19) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff01 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x323af)
  ) {
    return 2;
  }
  return 1;
}

export function getStringWidth(str: string): number {
  let w = 0;
  for (const { segment } of graphemeSegmenter.segment(str)) {
    w += getGraphemeWidth(segment);
  }
  return w;
}

function wrapWord(word: string, maxWidth: number): string[] {
  const chunks: string[] = [];
  let currentChunk = '';
  let currentWidth = 0;
  for (const { segment } of graphemeSegmenter.segment(word)) {
    const w = getGraphemeWidth(segment);
    if (currentWidth + w > maxWidth && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = segment;
      currentWidth = w;
    } else {
      currentChunk += segment;
      currentWidth += w;
    }
  }
  if (currentChunk) {
    chunks.push(currentChunk);
  }
  return chunks;
}

export function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [''];
  if (!text) return [];
  const sanitized = sanitizeTerminalText(text);
  const lines: string[] = [];
  const rawParagraphs = sanitized.split('\n');
  for (const para of rawParagraphs) {
    if (!para.trim()) {
      lines.push('');
      continue;
    }
    const words = para.split(/\s+/).filter(Boolean);
    let currentLine = '';
    let currentLineWidth = 0;
    for (const word of words) {
      const wordW = getStringWidth(word);
      if (wordW > maxWidth) {
        if (currentLine) {
          lines.push(currentLine);
          currentLine = '';
          currentLineWidth = 0;
        }
        const chunks = wrapWord(word, maxWidth);
        for (let i = 0; i < chunks.length; i++) {
          if (i === chunks.length - 1 && getStringWidth(chunks[i]) < maxWidth) {
            currentLine = chunks[i];
            currentLineWidth = getStringWidth(chunks[i]);
          } else {
            lines.push(chunks[i]);
          }
        }
      } else if (!currentLine) {
        currentLine = word;
        currentLineWidth = wordW;
      } else if (currentLineWidth + 1 + wordW <= maxWidth) {
        currentLine += ` ${word}`;
        currentLineWidth += 1 + wordW;
      } else {
        lines.push(currentLine);
        currentLine = word;
        currentLineWidth = wordW;
      }
    }
    if (currentLine) {
      lines.push(currentLine);
    }
  }
  return lines;
}
