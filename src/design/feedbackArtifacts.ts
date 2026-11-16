import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { getAppDataPath } from '../paths';
import { isValidDraftId } from './draftStore';

/** Queued messages outlive viewers. Keep their exact image and draft together,
 * independently of session cleanup and editable capture history (50 / 100 MiB). */
export function persistFeedbackArtifacts(id: string, json: string, screenshot?: string, limit = 50) {
  if (!isValidDraftId(id)) throw new Error('Invalid feedback draft ID');
  if (screenshot) {
    const stat = fs.lstatSync(screenshot);
    if (!stat.isFile() || stat.size > 32 * 1024 * 1024) throw new Error('Invalid feedback screenshot');
  }
  const image = screenshot ? fs.readFileSync(screenshot) : undefined;
  const bytes = Buffer.byteLength(json) + (image?.length ?? 0);
  if (bytes > 32 * 1024 * 1024) throw new Error('Feedback attachments exceed 32 MiB');
  const root = path.join(getAppDataPath(), 'feedback-artifacts');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, `${id}-${randomBytes(8).toString('hex')}`);
  fs.mkdirSync(dir, { mode: 0o700 });
  const draftPath = path.join(dir, 'draft.json');
  const capturePath = image ? path.join(dir, 'screenshot.png') : undefined;
  try {
    fs.writeFileSync(draftPath, json, { mode: 0o600, flag: 'wx' });
    if (capturePath && image) fs.writeFileSync(capturePath, image, { mode: 0o600, flag: 'wx' });
    const entries = fs.readdirSync(root).flatMap(name => {
      if (!/^(draft|cap)-[a-f0-9]{8,32}-[a-f0-9]{16}$/.test(name) && !/^[a-f0-9]{8,64}-[a-f0-9]{16}$/.test(name)) return [];
      const entry = path.join(root, name);
      const stat = fs.lstatSync(entry);
      if (!stat.isDirectory()) return [];
      const size = fs.readdirSync(entry).reduce((sum, file) => sum + fs.lstatSync(path.join(entry, file)).size, 0);
      return [{ entry, size, mtime: stat.mtimeMs }];
    }).sort((a, b) => a.entry === dir ? -1 : b.entry === dir ? 1 : b.mtime - a.mtime);
    let total = 0;
    entries.forEach((entry, index) => {
      total += entry.size;
      if (index >= limit || total > 100 * 1024 * 1024) fs.rmSync(entry.entry, { recursive: true });
    });
    return { draftPath, capturePath };
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}
