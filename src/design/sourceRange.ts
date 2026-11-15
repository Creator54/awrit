export interface SourceRange { startLine: number; endLine: number; text: string }

/** Selected context is bounded independently of the full source snapshot. */
export function sourceRangeContext(text: string, anchor: number, focus: number): SourceRange {
  const lines = text.split(/\r?\n/);
  const startLine = Math.min(anchor, focus);
  const endLine = Math.max(anchor, focus);
  if (!Number.isInteger(anchor) || !Number.isInteger(focus) || startLine < 1 || endLine > lines.length || endLine - startLine >= 100) throw new Error('Select between 1 and 100 source lines.');
  const selected = lines.slice(startLine - 1, endLine).join('\n');
  if (selected.length > 8192) throw new Error('Selected source exceeds 8192 characters.');
  return { startLine, endLine, text: selected };
}
