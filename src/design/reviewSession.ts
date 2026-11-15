import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getCapturesDir, loadFrozenCapture, persistCapture, type CollaborativeCapture } from '../presentation/collaborativeCapture';
import { listDrafts } from './draftStore';
import { normalizeRegionBox } from './regionBox';
import { parseCaptureProvenance } from '../remote/captureProvenance';

import { MAX_PNG_BYTES, MAX_COMMENT_CODEPOINTS, validateFrozenSource, validateDesignDraft } from './validation';
import type { FrozenSource } from './types';
import { parseTerminalReviewTarget, terminalReviewTarget } from './terminalReview';

function captureSource(capture: CollaborativeCapture, snapshot: CollaborativeCapture['source']) {
  const terminal = parseTerminalReviewTarget(capture.target);
  if (terminal) return validateFrozenSource({ kind: 'terminal', windowId: terminal.windowId });
  return validateFrozenSource(snapshot
    ? { kind: 'document', path: snapshot.path, sha256: snapshot.sha256 }
    : capture.isAdb ? { kind: 'adb', serial: capture.target } : { kind: 'web', url: capture.target });
}

/** Save design-mode frames through the same bounded history as CLI captures. */
export function saveReviewCapture(png: Buffer, id: string, source: FrozenSource, snapshot?: CollaborativeCapture['source']) {
  const target = source.kind === 'web' ? source.url : source.kind === 'adb' ? source.serial : source.kind === 'terminal' ? terminalReviewTarget(source.windowId, '/capture.png') : source.path;
  return persistCapture(png, target, source.kind === 'adb', { author: 'user' }, id, snapshot);
}

export async function loadReviewSession(id: string) {
  const capture = loadFrozenCapture(id);
  if (!capture) return undefined;
  try {
    const expected = path.join(getCapturesDir(), `${id}.png`);
    if (path.resolve(capture.imagePath) !== expected) return undefined;
    const stat = await fs.lstat(expected);
    if (!stat.isFile() || stat.size > MAX_PNG_BYTES) return undefined;
    const png = await fs.readFile(expected);
    if (png.length > MAX_PNG_BYTES || createHash('sha256').update(png).digest('hex') !== capture.sha256) return undefined;
    if (png.length < 24 || png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return undefined;
    const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
    if (width !== capture.width || height !== capture.height || !width || !height) return undefined;
    const candidate = capture.source;
    const snapshot = candidate && typeof candidate.path === 'string' && candidate.path.length <= 8192 && typeof candidate.text === 'string' && Buffer.byteLength(candidate.text) <= 1024 * 1024 && candidate.sha256 === createHash('sha256').update(candidate.text).digest('hex') ? candidate : undefined;
    const drafts = listDrafts({ width, height }).filter(d => d.captureId === id && d.captureSha256 === capture.sha256);
    const selectedDraft = drafts.find(d => d.id === id) ?? drafts[0];
    const captureProvenance = capture.captureOrigin?.kind === 'live-viewer'
      ? parseCaptureProvenance(capture.captureOrigin.provenance) : undefined;
    // Editable drafts cannot replace the captured attachment's identity.
    // Provenance comes from the immutable capture, never an editable draft.
    const source = captureSource(capture, snapshot);
    const bounds = normalizeRegionBox(capture.region, width, height) ?? { x: 0, y: 0, width, height };
    const commentPoints = Array.from(capture.comment ?? '');
    const initialNotes = [];
    for (let start = 0; start < commentPoints.length || (start === 0 && capture.region); start += MAX_COMMENT_CODEPOINTS) {
      initialNotes.push({
        id: `capture-comment-${start}`, comment: commentPoints.slice(start, start + MAX_COMMENT_CODEPOINTS).join(''),
        selection: { kind: 'region', bounds },
      });
    }
    const draft = selectedDraft ? { ...selectedDraft, captureProvenance } : validateDesignDraft({
      version: 1, id, captureId: id, captureSha256: capture.sha256, source,
      ...(captureProvenance ? { captureProvenance } : {}),
      annotations: initialNotes,
      state: 'editing',
    }, { width, height });
    return { png, width, height, captureId: id, captureSha256: capture.sha256, captureProvenance, source, snapshot, draft, sentRevisions: capture.sentRevisions ?? {} };
  } catch { return undefined; }
}
