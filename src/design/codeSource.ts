import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getAppDataPath } from '../paths';
import type { FrozenSource } from './types';

export async function readCodeSnapshot(url: string, root?: string): Promise<{ path: string; sha256: string; text: string } | undefined> {
  const source = await readCodeSource(url, root);
  if (!source || source.kind !== 'document' || !source.sha256) return undefined;
  const file = path.join(path.dirname(fileURLToPath(url)), 'source.txt');
  try {
    const real = await fs.realpath(file);
    const parent = await fs.realpath(path.dirname(fileURLToPath(url)));
    if (path.dirname(real) !== parent || (await fs.stat(real)).size > 1024 * 1024) return undefined;
    const bytes = await fs.readFile(real);
    if (bytes.length > 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== source.sha256) return undefined;
    return { path: source.path, sha256: source.sha256, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/** Only Awrit-generated snapshots carry trusted source identity; page DOM is untrusted. */
export async function readCodeSource(url: string, root = path.join(getAppDataPath(), 'code-pages')): Promise<FrozenSource | undefined> {
  let file: string;
  try { file = fileURLToPath(url); } catch { return undefined; }
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(file)]);
    const relative = path.relative(realRoot, realFile);
    if (!/^page-[a-zA-Z0-9]+[\\/]index\.html$/.test(relative)) return undefined;
    file = realFile;
    const raw: unknown = JSON.parse(await fs.readFile(path.join(path.dirname(file), 'source.json'), 'utf8'));
    if (typeof raw !== 'object' || raw === null || !('path' in raw) || !('sha256' in raw)) return undefined;
    if (typeof raw.path !== 'string' || !path.isAbsolute(raw.path) || typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256)) return undefined;
    return { kind: 'document', path: raw.path, sha256: raw.sha256 };
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && 'code' in error && error.code === 'ENOENT')) return undefined;
    throw error;
  }
}
