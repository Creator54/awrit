import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getAppDataPath } from '../paths';
import type { DesignDraft, Dimensions } from './types';
import { validateDesignDraft } from './validation';

export const MAX_DRAFTS_STORED = 10;
export const MAX_DRAFTS_BYTES = 100 * 1024 * 1024; // 100 MiB

// Support draft IDs with prefix like draft-..., cap-..., or hex IDs 8-64 chars
const DRAFT_ID_REGEX = /^([a-f0-9]{8,64}|(draft|cap)-[a-f0-9]{8,32})$/;

export function isValidDraftId(id: unknown): id is string {
  if (typeof id !== 'string') return false;
  return DRAFT_ID_REGEX.test(id);
}

export function getDraftsDir(): string {
  const dir = path.join(getAppDataPath(), 'design-drafts');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    fs.chmodSync(dir, 0o700);
  } catch {}
  return dir;
}

export function saveDraft(
  draft: DesignDraft,
  pngDims: Dimensions,
  pruneLimit = MAX_DRAFTS_STORED,
): void {
  const validated = validateDesignDraft(draft, pngDims);
  if (!isValidDraftId(validated.id)) {
    throw new Error(`Invalid draft ID format: "${validated.id}"`);
  }

  const draftsDir = getDraftsDir();
  const finalJsonPath = path.join(draftsDir, `${validated.id}.json`);
  const tmpJsonPath = `${finalJsonPath}.${randomBytes(4).toString('hex')}.tmp`;

  try {
    fs.writeFileSync(tmpJsonPath, JSON.stringify(validated, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
    fs.chmodSync(tmpJsonPath, 0o600);
    fs.renameSync(tmpJsonPath, finalJsonPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpJsonPath)) fs.unlinkSync(tmpJsonPath);
    } catch {}
    throw err;
  }

  pruneDrafts(pngDims, pruneLimit);
}

export function loadDraft(id: string, pngDims: Dimensions): DesignDraft | null {
  if (!isValidDraftId(id)) return null;
  const filePath = path.join(getDraftsDir(), `${id}.json`);
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    return validateDesignDraft(parsed, pngDims);
  } catch {
    return null;
  }
}

export function deleteDraft(id: string): boolean {
  if (!isValidDraftId(id)) return false;
  const filePath = path.join(getDraftsDir(), `${id}.json`);
  try {
    if (!fs.existsSync(filePath)) return false;
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

interface DraftFileItem {
  id: string;
  filePath: string;
  mtimeMs: number;
  sizeBytes: number;
}

export function listDrafts(pngDims: Dimensions, limit = MAX_DRAFTS_STORED): DesignDraft[] {
  const dir = getDraftsDir();
  try {
    const files = fs.readdirSync(dir);
    const jsonFiles = files.filter((f) => f.endsWith('.json'));

    const items: DraftFileItem[] = [];
    for (const f of jsonFiles) {
      const id = f.slice(0, -5);
      if (!isValidDraftId(id)) continue;
      const fullPath = path.join(dir, f);
      try {
        const st = fs.statSync(fullPath);
        items.push({ id, filePath: fullPath, mtimeMs: st.mtimeMs, sizeBytes: st.size });
      } catch {}
    }

    items.sort((a, b) => b.mtimeMs - a.mtimeMs);

    const result: DesignDraft[] = [];
    for (const item of items) {
      if (result.length >= limit) break;
      const loaded = loadDraft(item.id, pngDims);
      if (loaded) result.push(loaded);
    }
    return result;
  } catch {
    return [];
  }
}

export function pruneDrafts(
  pngDims: Dimensions,
  limit = MAX_DRAFTS_STORED,
  maxBytes = MAX_DRAFTS_BYTES,
): void {
  const dir = getDraftsDir();
  try {
    const files = fs.readdirSync(dir);

    // Clean up stale temporary files older than 1 hour
    const now = Date.now();
    for (const f of files) {
      if (/^(?:[a-f0-9]{8,64}|(?:draft|cap)-[a-f0-9]{8,32})\.json\.[a-f0-9]{8}\.tmp$/.test(f)) {
        const tmpPath = path.join(dir, f);
        try {
          const st = fs.lstatSync(tmpPath);
          if (st.isFile() && now - st.mtimeMs > 3600_000) {
            fs.unlinkSync(tmpPath);
          }
        } catch {}
      }
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    const items: DraftFileItem[] = [];
    let totalBytes = 0;

    for (const f of jsonFiles) {
      const id = f.slice(0, -5);
      if (!isValidDraftId(id)) continue;
      const fullPath = path.join(dir, f);
      try {
        const st = fs.statSync(fullPath);
        items.push({ id, filePath: fullPath, mtimeMs: st.mtimeMs, sizeBytes: st.size });
        totalBytes += st.size;
      } catch {}
    }

    if (items.length <= limit && totalBytes <= maxBytes) return;

    // Sort newest first
    items.sort((a, b) => b.mtimeMs - a.mtimeMs);

    // Scan oldest items from the tail forward
    for (let i = items.length - 1; i >= 0; i--) {
      if (items.length <= limit && totalBytes <= maxBytes) break;

      const item = items[i];
      try {
        const loaded = loadDraft(item.id, pngDims);
        if (loaded === null) {
          // Quarantine corrupted draft file rather than silently unlinking
          const corruptPath = `${item.filePath}.corrupt`;
          fs.renameSync(item.filePath, corruptPath);
          totalBytes -= item.sizeBytes;
          items.splice(i, 1);
          continue;
        }

        // Spec rule: NEVER silently prune drafts in 'sending' or 'unknown' delivery state
        if (loaded.state === 'sending' || loaded.state === 'unknown') {
          continue;
        }

        // Only prune completed ('accepted' | 'failed') or stale 'editing' drafts automatically
        if (loaded.state === 'accepted' || loaded.state === 'failed' || loaded.state === 'editing') {
          if (fs.existsSync(item.filePath)) {
            fs.unlinkSync(item.filePath);
            totalBytes -= item.sizeBytes;
            items.splice(i, 1);
          }
        }
      } catch {}
    }
  } catch {}
}
