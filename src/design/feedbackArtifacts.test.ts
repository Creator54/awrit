import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { persistFeedbackArtifacts } from './feedbackArtifacts';

test('queued feedback artifacts survive session deletion and enforce retention', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-feedback-'));
  const old = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = root;
  try {
    const session = path.join(root, 'session');
    fs.mkdirSync(session);
    const screenshot = path.join(session, 'crop.png');
    fs.writeFileSync(screenshot, Buffer.from('test image'));
    const saved = persistFeedbackArtifacts('draft-12345678', '{"annotations":[]}', screenshot);
    fs.rmSync(session, { recursive: true });
    if (!saved.capturePath) throw new Error('Missing persisted screenshot');
    expect(fs.readFileSync(saved.capturePath, 'utf8')).toBe('test image');
    expect(fs.readFileSync(saved.draftPath, 'utf8')).toBe('{"annotations":[]}');
    expect(fs.statSync(saved.capturePath).mode & 0o777).toBe(0o600);
    expect(() => persistFeedbackArtifacts('../escape', '{}')).toThrow();
    persistFeedbackArtifacts('draft-87654321', '{}', undefined, 1);
    expect(fs.existsSync(saved.draftPath)).toBe(false);
    expect(fs.existsSync(saved.capturePath)).toBe(false);
  } finally {
    if (old === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = old;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
