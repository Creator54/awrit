import { afterEach, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ArtifactOffer, parseArtifactOffer, receiveArtifact } from './artifacts';

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'awrit-artifacts-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeOffer(content: Uint8Array, overrides: Partial<ArtifactOffer> = {}): ArtifactOffer {
  return {
    id: 'capture-1',
    name: 'capture.png',
    mime: 'image/png',
    size: content.byteLength,
    sha256: createHash('sha256').update(content).digest('hex'),
    ...overrides,
  };
}

async function* chunksOf(content: Uint8Array, chunkSize = 3): AsyncIterable<Uint8Array> {
  for (let offset = 0; offset < content.length; offset += chunkSize) {
    yield content.subarray(offset, offset + chunkSize);
  }
}

function validOfferValue() {
  return {
    id: 'art_9-Z',
    name: 'capture.png',
    mime: 'image/png',
    size: 128,
    sha256: 'a'.repeat(64),
  };
}

describe('parseArtifactOffer', () => {
  test('accepts a valid offer and returns only the known fields', () => {
    const parsed = parseArtifactOffer(validOfferValue());
    expect(parsed).toEqual(validOfferValue());
  });

  test('accepts each allowed mime type', () => {
    for (const mime of [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'application/json',
      'text/plain',
    ]) {
      expect(parseArtifactOffer({ ...validOfferValue(), mime }).mime).toBe(mime);
    }
  });

  test('accepts the size bounds', () => {
    expect(parseArtifactOffer({ ...validOfferValue(), size: 0 }).size).toBe(0);
    expect(parseArtifactOffer({ ...validOfferValue(), size: 256 * 1024 * 1024 }).size).toBe(
      256 * 1024 * 1024,
    );
  });

  test('rejects non-objects and arrays', () => {
    for (const value of [null, undefined, 'offer', 42, [], new Date()]) {
      expect(() => parseArtifactOffer(value)).toThrow(/invalid artifact offer/);
    }
  });

  test('rejects missing and extra keys', () => {
    const missing = validOfferValue() as Record<string, unknown>;
    delete missing.sha256;
    expect(() => parseArtifactOffer(missing)).toThrow(/invalid artifact offer/);
    expect(() => parseArtifactOffer({ ...validOfferValue(), path: '/etc/passwd' })).toThrow(
      /invalid artifact offer/,
    );
  });

  test('rejects bad ids', () => {
    for (const id of ['', 'has space', 'x'.repeat(65), 'semi;colon', 'slash/id', 7]) {
      expect(() => parseArtifactOffer({ ...validOfferValue(), id })).toThrow(
        /invalid artifact offer/,
      );
    }
  });

  test('rejects names that are not a single safe basename', () => {
    const names = [
      '',
      '.',
      '..',
      '../escape.png',
      'dir/name.png',
      'dir\\name.png',
      'nul\u0000byte',
      'line\nfeed',
      'del\u007fchar',
      'c1\u0085char',
      'x'.repeat(256),
      'é'.repeat(128),
      123,
    ];
    for (const name of names) {
      expect(() => parseArtifactOffer({ ...validOfferValue(), name })).toThrow(
        /invalid artifact offer/,
      );
    }
    expect(parseArtifactOffer({ ...validOfferValue(), name: 'x'.repeat(255) }).name).toHaveLength(
      255,
    );
  });

  test('rejects mimes outside the allow-list', () => {
    for (const mime of ['text/html', 'application/octet-stream', 'image/svg+xml', '', 5]) {
      expect(() => parseArtifactOffer({ ...validOfferValue(), mime })).toThrow(
        /invalid artifact offer/,
      );
    }
  });

  test('rejects bad sizes', () => {
    for (const size of [
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      256 * 1024 * 1024 + 1,
      '4',
    ]) {
      expect(() => parseArtifactOffer({ ...validOfferValue(), size })).toThrow(
        /invalid artifact offer/,
      );
    }
  });

  test('rejects bad hashes', () => {
    for (const sha256 of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64), '', 'a'.repeat(65), 7]) {
      expect(() => parseArtifactOffer({ ...validOfferValue(), sha256 })).toThrow(
        /invalid artifact offer/,
      );
    }
  });
});

describe('receiveArtifact', () => {
  test('publishes a verified file and returns its absolute path', async () => {
    const dir = makeDir();
    const content = new TextEncoder().encode('png-ish bytes for the artifact test');
    const offer = makeOffer(content);
    const target = path.join(dir, offer.name);

    let targetExistedWhileStreaming = false;
    async function* probe(): AsyncIterable<Uint8Array> {
      for await (const chunk of chunksOf(content)) {
        yield chunk;
        targetExistedWhileStreaming ||= existsSync(target);
      }
    }

    const result = await receiveArtifact(offer, probe(), dir);

    expect(result).toBe(path.resolve(target));
    expect(targetExistedWhileStreaming).toBe(false);
    expect(readFileSync(target).equals(Buffer.from(content))).toBe(true);
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(readdirSync(dir)).toEqual([offer.name]);
  });

  test('rejects a short stream without leaving files', async () => {
    const dir = makeDir();
    const content = new TextEncoder().encode('0123456789');
    const offer = makeOffer(content);

    await expect(receiveArtifact(offer, chunksOf(content.subarray(0, 4)), dir)).rejects.toThrow(
      /size mismatch/,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  test('stops as soon as the declared size is exceeded', async () => {
    const dir = makeDir();
    const offer = makeOffer(new Uint8Array(4));
    let askedForMore = false;
    async function* tooMuch(): AsyncIterable<Uint8Array> {
      yield new Uint8Array(8);
      askedForMore = true;
      yield new Uint8Array(8);
    }

    await expect(receiveArtifact(offer, tooMuch(), dir)).rejects.toThrow(/exceeds declared size/);
    expect(askedForMore).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('rejects a hash mismatch without leaving files', async () => {
    const dir = makeDir();
    const content = new TextEncoder().encode('payload');
    const offer = makeOffer(content, { sha256: 'b'.repeat(64) });

    await expect(receiveArtifact(offer, chunksOf(content), dir)).rejects.toThrow(/hash mismatch/);
    expect(readdirSync(dir)).toEqual([]);
  });

  test('cleans up when the stream fails mid-transfer', async () => {
    const dir = makeDir();
    const offer = makeOffer(new Uint8Array(12));
    async function* broken(): AsyncIterable<Uint8Array> {
      yield new Uint8Array([1, 2, 3]);
      throw new Error('connection lost');
    }

    await expect(receiveArtifact(offer, broken(), dir)).rejects.toThrow('connection lost');
    expect(readdirSync(dir)).toEqual([]);
  });

  test('refuses an existing target unless overwrite is set', async () => {
    const dir = makeDir();
    const content = new TextEncoder().encode('new');
    const offer = makeOffer(content);
    const target = path.join(dir, offer.name);
    writeFileSync(target, 'old');

    await expect(receiveArtifact(offer, chunksOf(content), dir)).rejects.toThrow(/already exists/);
    expect(readFileSync(target, 'utf8')).toBe('old');
    expect(readdirSync(dir)).toEqual([offer.name]);

    const result = await receiveArtifact(offer, chunksOf(content), dir, { overwrite: true });
    expect(result).toBe(path.resolve(target));
    expect(readFileSync(target).equals(Buffer.from(content))).toBe(true);
    expect(readdirSync(dir)).toEqual([offer.name]);
  });

  test('refuses a symlink target even with overwrite', async () => {
    const dir = makeDir();
    const content = new TextEncoder().encode('new');
    const offer = makeOffer(content);
    writeFileSync(path.join(dir, 'real.bin'), 'keep');
    symlinkSync('real.bin', path.join(dir, offer.name));

    await expect(
      receiveArtifact(offer, chunksOf(content), dir, { overwrite: true }),
    ).rejects.toThrow(/symbolic link/);
    expect(readFileSync(path.join(dir, 'real.bin'), 'utf8')).toBe('keep');
    expect(readdirSync(dir).sort()).toEqual(['capture.png', 'real.bin']);
  });

  test('refuses a symlink destination directory', async () => {
    const real = makeDir();
    const link = path.join(makeDir(), 'link');
    symlinkSync(real, link);

    await expect(
      receiveArtifact(makeOffer(new Uint8Array(1)), chunksOf(new Uint8Array(1)), link),
    ).rejects.toThrow(/symbolic link/);
    expect(readdirSync(real)).toEqual([]);
  });

  test('rejects an invalid offer before creating anything', async () => {
    const dir = makeDir();
    const offer = makeOffer(new Uint8Array(1), { name: '../escape.png' });

    await expect(receiveArtifact(offer, chunksOf(new Uint8Array(1)), dir)).rejects.toThrow(
      /invalid artifact offer/,
    );
    expect(readdirSync(dir)).toEqual([]);
  });
});
