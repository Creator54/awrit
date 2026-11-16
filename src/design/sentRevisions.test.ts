import { expect, test } from 'bun:test';
import { acceptedRevisions, annotationRevision } from './sentRevisions';
import type { Annotation, DesignDraft } from './types';

test('only acknowledged exact revisions count as sent, independently of property order', () => {
  const note: Annotation = { id: 'one', comment: 'hello', selection: { kind: 'region', bounds: { x: 0, y: 0, width: 1, height: 1 } } };
  const draft: DesignDraft = { version: 1, id: 'draft-12345678', captureId: 'cap-12345678', captureSha256: 'hash', source: { kind: 'web', url: 'https://test/' }, annotations: [note], state: 'failed' };
  expect(acceptedRevisions([draft])).toEqual({});
  const revisions = acceptedRevisions([{ ...draft, state: 'accepted' }]);
  expect(revisions.one).toContain(annotationRevision({ selection: note.selection, comment: 'hello', id: 'one' }));
  expect(revisions.one).not.toContain(annotationRevision({ ...note, comment: 'edited' }));
});
