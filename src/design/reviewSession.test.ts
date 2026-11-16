import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { saveReviewCapture, loadReviewSession } from './reviewSession';
import { saveDraft } from './draftStore';
import { updateCaptureSentRevisions, persistCapture } from '../presentation/collaborativeCapture';
import { acceptedRevisions } from './sentRevisions';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
test('saved review restores verified image and matching annotations; rejects tampered PNG', async () => {
  const old = process.env.XDG_DATA_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-review-'));
  process.env.XDG_DATA_HOME = root;
  try {
    const id = 'cap-12345678abcd';
    const provenance = { session: 'remote-session', generation: 2, epoch: 3 };
    const capture = persistCapture(png, 'https://example.test/original', false, { author: 'user' }, id, undefined,
      { kind: 'live-viewer', paneId: 'remote-pane', provenance });
    const note = { id: 'ann-1', comment: 'original note', selection: { kind: 'region' as const, bounds: { x: 0, y: 0, width: 1, height: 1 } } };
    saveDraft({ version: 1, id: 'draft-12345678', captureId: id, captureSha256: capture.sha256, source: { kind: 'web', url: 'https://example.test/original' }, annotations: [note], state: 'editing' }, { width: 2, height: 2 });
    const session = await loadReviewSession(id);
    expect(session?.draft?.annotations).toEqual([note]);
    expect(session?.captureProvenance).toEqual(provenance);
    expect(session?.draft?.captureProvenance).toEqual(provenance);
    expect(session?.source).toEqual({ kind: 'web', url: 'https://example.test/original' });
    expect(session?.png).toEqual(png);
    expect(await loadReviewSession('../private')).toBeUndefined();
    // A later one-note submission must not replace the complete editable review.
    saveDraft({ version: 1, id, captureId: id, captureSha256: capture.sha256, source: { kind: 'web', url: 'https://forged.test/' }, annotations: [note, { ...note, id: 'ann-2' }], state: 'editing' }, { width: 2, height: 2 });
    saveDraft({ version: 1, id: 'draft-87654321', captureId: id, captureSha256: capture.sha256, source: { kind: 'web', url: 'https://forged.test/' }, annotations: [note], state: 'editing' }, { width: 2, height: 2 });
    const reopened = await loadReviewSession(id);
    expect(reopened?.draft?.annotations).toHaveLength(2);
    expect(reopened?.sentRevisions).toEqual({});
    saveDraft({ version: 1, id: 'draft-11112222', captureId: id, captureSha256: capture.sha256, source: { kind: 'web', url: 'https://example.test/original' }, annotations: [note], state: 'accepted' }, { width: 2, height: 2 });
    updateCaptureSentRevisions(id, acceptedRevisions([{ version: 1, id: 'draft-11112222', captureId: id, captureSha256: capture.sha256, source: { kind: 'web', url: 'https://example.test/original' }, annotations: [note], state: 'accepted' }]));
    const accepted = await loadReviewSession(id);
    expect(accepted?.sentRevisions['ann-1']).toHaveLength(1);
    expect(accepted?.sentRevisions['ann-2']).toBeUndefined();
    expect(reopened?.source).toEqual({ kind: 'web', url: 'https://example.test/original' });
    fs.chmodSync(capture.imagePath, 0o600);
    fs.writeFileSync(capture.imagePath, Buffer.concat([png, Buffer.from('tampered')]));
    expect(await loadReviewSession(id)).toBeUndefined();
  } finally {
    if (old === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('capture without a review draft opens with its saved comment and attachment identity', async () => {
  const old = process.env.XDG_DATA_HOME;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-capture-review-'));
  process.env.XDG_DATA_HOME = root;
  try {
    const id = 'cap-abcdefabcdef';
    const provenance = { session: 'remote-pane', generation: 1, epoch: 2 };
    persistCapture(png, 'https://example.test', false, { comment: 'Fix this layout', region: { x: 1, y: 0, width: 1, height: 2 } }, id, undefined,
      { kind: 'live-viewer', paneId: 'remote', provenance });
    const session = await loadReviewSession(id);
    expect(session?.draft?.captureId).toBe(id);
    expect(session?.draft?.captureProvenance).toEqual(provenance);
    expect(session?.draft?.annotations[0]?.comment).toBe('Fix this layout');
    expect(session?.draft?.annotations[0]?.selection.bounds).toEqual({ x: 1, y: 0, width: 1, height: 2 });
    expect(session?.draft?.state).toBe('editing');
    const regionId = 'cap-aabbccddeeff';
    persistCapture(png, 'https://example.test', false, { region: { x: 1, y: 0, width: 1, height: 2 } }, regionId);
    const regionReview = await loadReviewSession(regionId);
    expect(regionReview?.draft?.annotations).toHaveLength(1);
    expect(regionReview?.draft?.annotations[0]?.comment).toBe('');
    expect(regionReview?.draft?.annotations[0]?.selection.bounds).toEqual({ x: 1, y: 0, width: 1, height: 2 });
    const longId = 'cap-fedcbafedcba';
    const comment = 'x'.repeat(4096);
    persistCapture(png, 'https://example.test', false, { comment }, longId);
    const longReview = await loadReviewSession(longId);
    expect(longReview?.draft?.annotations.map(note => note.comment).join('')).toBe(comment);
    expect(longReview?.draft?.annotations).toHaveLength(3);
  } finally {
    if (old === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('fresh process restores source identity without original file or page cache', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-source-restart-'));
  const old = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = root;
  try {
    const original = path.join(root, 'original.ts');
    const text = 'export const retained = 42;';
    fs.writeFileSync(original, text);
    const snapshot = { path: original, text, sha256: createHash('sha256').update(text).digest('hex') };
    const id = 'cap-abcdef123456';
    saveReviewCapture(png, id, { kind: 'document', path: original, sha256: snapshot.sha256 }, snapshot);
    fs.unlinkSync(original);
    const module = fileURLToPath(new URL('./reviewSession.ts', import.meta.url));
    const child = Bun.spawn([process.execPath, '-e', `import { loadReviewSession } from ${JSON.stringify(module)}; const s = await loadReviewSession('${id}'); console.log(JSON.stringify({ source: s?.source, snapshot: s?.snapshot }));`], {
      env: { ...process.env, XDG_DATA_HOME: root }, stdout: 'pipe', stderr: 'pipe',
    });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(JSON.parse(output)).toEqual({ source: { kind: 'document', path: original, sha256: snapshot.sha256 }, snapshot });
  } finally {
    if (old === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
