import type { Annotation, DesignDraft } from './types';

/** Stable across IPC validation rebuilding objects in a different property order. */
export function annotationRevision(note: Annotation): string {
  return JSON.stringify(note, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]]));
  });
}

export function acceptedRevisions(drafts: DesignDraft[]): Record<string, string[]> {
  const revisions: Record<string, string[]> = Object.create(null);
  for (const draft of drafts) {
    if (draft.state !== 'accepted') continue;
    for (const note of draft.annotations) {
      revisions[note.id] ??= [];
      revisions[note.id].push(annotationRevision(note));
    }
  }
  return revisions;
}
