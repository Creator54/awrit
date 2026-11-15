export interface DiffLine {
  kind: 'meta' | 'context' | 'added' | 'removed';
  text: string;
  oldLine?: number;
  newLine?: number;
}

/** Unified diff coordinates, never confused with physical lines in the patch file. */
export function mapDiffLines(lines: string[]): DiffLine[] {
  let oldLine = 0;
  let newLine = 0;
  let oldRemaining = 0;
  let newRemaining = 0;
  return lines.map((text) => {
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldRemaining = Number(hunk[2] ?? 1);
      newRemaining = Number(hunk[4] ?? 1);
      return { kind: 'meta', text };
    }
    if (text.startsWith(' ') && oldRemaining > 0 && newRemaining > 0) {
      oldRemaining--; newRemaining--;
      return { kind: 'context', text, oldLine: oldLine++, newLine: newLine++ };
    }
    if (text.startsWith('-') && oldRemaining > 0) {
      oldRemaining--;
      return { kind: 'removed', text, oldLine: oldLine++ };
    }
    if (text.startsWith('+') && newRemaining > 0) {
      newRemaining--;
      return { kind: 'added', text, newLine: newLine++ };
    }
    // File headers and malformed rows terminate a hunk; the no-newline marker does not.
    if (!text.startsWith('\\ No newline at end of file')) {
      oldRemaining = 0; newRemaining = 0;
    }
    return { kind: 'meta', text };
  });
}
