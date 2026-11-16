import type { FrozenSource } from './types';
import { sourceRangeContext, type SourceRange } from './sourceRange';

/** Called by the owner, not the renderer, before accepting source feedback. */
export function verifySourceFeedback(
  notes: readonly { sourceRange?: SourceRange }[],
  source: FrozenSource | undefined,
  snapshot: { path: string; sha256: string; text: string } | undefined,
): void {
  if (!notes.some(note => note.sourceRange)) return;
  if (!snapshot || source?.kind !== 'document' || snapshot.path !== source.path || snapshot.sha256 !== source.sha256) throw new Error('Source snapshot no longer matches this capture');
  for (const note of notes) {
    if (!note.sourceRange) continue;
    const context = sourceRangeContext(snapshot.text, note.sourceRange.startLine, note.sourceRange.endLine);
    if (context.text !== note.sourceRange.text) throw new Error('Source context does not match snapshot');
  }
}
