import { expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCodePage } from '../presentation/codePage';
import { readCodeSource, readCodeSnapshot } from './codeSource';
import { validateFrozenSource } from './validation';

test('generated source identity survives validation and excludes arbitrary pages', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'awrit-provenance-'));
  try {
    const file = path.join(root, 'sample.ts');
    await fs.writeFile(file, 'hello');
    const pages = path.join(root, 'pages');
    const page = await createCodePage(file, { outputRoot: pages });
    expect(await readCodeSnapshot(pathToFileURL(page).href, pages)).toMatchObject({ text: 'hello', path: await fs.realpath(file) });
    await fs.writeFile(path.join(path.dirname(page), 'source.txt'), 'changed');
    expect(await readCodeSnapshot(pathToFileURL(page).href, pages)).toBeUndefined();
    const source = await readCodeSource(pathToFileURL(page).href, pages);
    expect(source).toEqual({ kind: 'document', path: await fs.realpath(file), sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824' });
    expect(validateFrozenSource(source)).toMatchObject(source ?? {});
    expect(await readCodeSource(pathToFileURL(file).href, pages)).toBeUndefined();
    expect(await readCodeSource('https://example.com', pages)).toBeUndefined();
    const alias = path.join(root, 'pages-alias');
    await fs.symlink(pages, alias, 'dir');
    expect(await readCodeSource(pathToFileURL(page).href, alias)).toEqual(source);
    expect(() => validateFrozenSource({ kind: 'document', path: file, sha256: 'bad' })).toThrow();
    await fs.writeFile(path.join(path.dirname(page), 'source.json'), '{}');
    expect(await readCodeSource(pathToFileURL(page).href, pages)).toBeUndefined();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
