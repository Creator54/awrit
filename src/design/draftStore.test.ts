import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  deleteDraft,
  getDraftsDir,
  isValidDraftId,
  listDrafts,
  loadDraft,
  pruneDrafts,
  saveDraft,
} from './draftStore';
import type { DesignDraft, Dimensions } from './types';

let tempDir: string;
const originalDataHome = process.env.XDG_DATA_HOME;

const dims: Dimensions = { width: 1000, height: 800 };

function createSampleDraft(
  id: string,
  state: DesignDraft['state'] = 'editing',
  comment = 'First issue',
): DesignDraft {
  return {
    version: 1,
    id,
    captureId: 'cap-0123456789ab',
    captureSha256: 'a'.repeat(64),
    source: { kind: 'web', url: 'https://example.test/' },
    state,
    annotations: [
      {
        id: 'ann-1',
        comment,
        selection: {
          kind: 'region',
          bounds: { x: 10, y: 10, width: 100, height: 50 },
        },
      },
    ],
  };
}

describe('draftStore', () => {
  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-drafts-test-'));
    process.env.XDG_DATA_HOME = tempDir;
  });

  afterEach(() => {
    if (originalDataHome !== undefined) process.env.XDG_DATA_HOME = originalDataHome;
    else delete process.env.XDG_DATA_HOME;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('isValidDraftId enforces hex/capture IDs and rejects path traversal', () => {
    expect(isValidDraftId('0123456789abcdef')).toBe(true);
    expect(isValidDraftId('12345678')).toBe(true);
    expect(isValidDraftId('cap-0123456789ab')).toBe(true);
    expect(isValidDraftId('../secret')).toBe(false);
    expect(isValidDraftId('')).toBe(false);
    expect(isValidDraftId('bad/id')).toBe(false);
    expect(isValidDraftId(null as any)).toBe(false);
  });

  test('saveDraft creates atomic file with 0o600 permissions in 0o700 dir', () => {
    const draft = createSampleDraft('1234567890abcdef');
    saveDraft(draft, dims);

    const dir = getDraftsDir();
    expect(fs.existsSync(dir)).toBe(true);
    const dirStat = fs.statSync(dir);
    expect(dirStat.mode & 0o777).toBe(0o700);

    const filePath = path.join(dir, `${draft.id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const fileStat = fs.statSync(filePath);
    expect(fileStat.mode & 0o777).toBe(0o600);

    const loaded = loadDraft(draft.id, dims);
    expect(loaded).toEqual(draft);
  });

  test('loadDraft returns null for missing or invalid drafts', () => {
    expect(loadDraft('nonexistent1234', dims)).toBeNull();
    expect(loadDraft('../traversal', dims)).toBeNull();

    // Corrupted file
    const dir = getDraftsDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'corrupt12345678.json'), '{ invalid json');
    expect(loadDraft('corrupt12345678', dims)).toBeNull();
  });

  test('deleteDraft safely removes draft file', () => {
    const draft = createSampleDraft('abcdef0123456789');
    saveDraft(draft, dims);
    expect(deleteDraft(draft.id)).toBe(true);
    expect(loadDraft(draft.id, dims)).toBeNull();
    expect(deleteDraft(draft.id)).toBe(false);
    expect(deleteDraft('../traversal')).toBe(false);
  });

  test('listDrafts returns valid drafts sorted newest first up to limit', async () => {
    for (let i = 0; i < 5; i++) {
      const id = `000000000000000${i}`;
      saveDraft(createSampleDraft(id, 'editing', `Draft ${i}`), dims);
      await new Promise((r) => setTimeout(r, 5));
    }

    const drafts = listDrafts(dims, 3);
    expect(drafts.length).toBe(3);
    expect(drafts.map((d) => d.id)).toContain('0000000000000004');
  });

  test('pruneDrafts caps at max 10 drafts and NEVER prunes sending or unknown states', async () => {
    // Create 10 drafts in editing
    for (let i = 0; i < 10; i++) {
      const id = `draft-${i.toString(16).padStart(8, '0')}`;
      saveDraft(createSampleDraft(id, 'editing', `Editing ${i}`), dims);
      await new Promise((r) => setTimeout(r, 2));
    }
    const sendingDraft = createSampleDraft('draft-aaaa0001', 'sending', 'In Flight');
    const unknownDraft = createSampleDraft('draft-aaaa0002', 'unknown', 'Delivery Unknown');
    saveDraft(sendingDraft, dims);
    saveDraft(unknownDraft, dims);

    pruneDrafts(dims, 10);

    // Both protected drafts must survive
    expect(loadDraft('draft-aaaa0001', dims)).not.toBeNull();
    expect(loadDraft('draft-aaaa0002', dims)).not.toBeNull();

    // Total drafts should now be capped at 10
    const remaining = listDrafts(dims, 20);
    expect(remaining.length).toBeLessThanOrEqual(10);
  });
});
