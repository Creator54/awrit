import { describe, expect, test } from 'bun:test';
import {
  decodeMediaEnvelope,
  encodeMediaEnvelope,
  LIMITS,
  MediaDecoder,
  type MediaMeta,
  parseControl,
} from './protocol';

const meta: MediaMeta = {
  session: 's1',
  surface: 'content',
  generation: 1,
  epoch: 3,
  frame: 7,
  codec: 'jpeg',
  width: 1280,
  height: 720,
  x: 0,
  y: 0,
  z: 0,
};

function envelope(metaJson: string, payload: Uint8Array): Buffer {
  const json = Buffer.from(metaJson);
  const bytes = Buffer.alloc(8 + json.length + payload.length);
  bytes.writeUInt32BE(json.length, 0);
  bytes.writeUInt32BE(payload.length, 4);
  json.copy(bytes, 8);
  bytes.set(payload, 8 + json.length);
  return bytes;
}

describe('parseControl', () => {
  test('validates Android selectors and canonical device URLs', () => {
    expect(
      parseControl({
        type: 'create-android',
        request: 'r',
        device: '127.0.0.1:5555',
        url: 'android://127.0.0.1%3A5555',
      }).type,
    ).toBe('create-android');
    for (const [device, url] of [
      ['phone', 'https://example.com'],
      ['phone', 'android://other'],
      ['bad;cmd', 'android://bad%3Bcmd'],
      ['phone', 'android://user@phone'],
    ])
      expect(() => parseControl({ type: 'create-android', request: 'r', device, url })).toThrow();
  });

  test('accepts a valid hello', () => {
    expect(
      parseControl({ type: 'hello', version: 1, build: 'abc', codecs: ['jpeg', 'png'] }),
    ).toEqual({
      type: 'hello',
      version: 1,
      build: 'abc',
      codecs: ['jpeg', 'png'],
    });
  });
  test('rejects unknown types and extra fields', () => {
    expect(() => parseControl({ type: 'shell', cmd: 'rm' })).toThrow();
    expect(() => parseControl({ type: 'heartbeat', extra: 1 })).toThrow();
    expect(() => parseControl({ type: 'file-chooser-unsupported', extra: 1 })).toThrow();
  });
  test('input requires increasing integer seq and generation', () => {
    expect(() =>
      parseControl({ type: 'input', seq: -1, generation: 1, event: { kind: 'key', key: 'a' } }),
    ).toThrow();
  });

  test('accepts bounded upload handshake messages without local paths', () => {
    const offer = {
      id: 'a1',
      name: 'chosen.txt',
      mime: 'text/plain',
      size: 12,
      sha256: 'a'.repeat(64),
    };
    for (const message of [
      { type: 'file-chooser', chooser: 'c1' },
      { type: 'upload-offer', chooser: 'c1', offer },
      { type: 'upload-grant', chooser: 'c1', token: 'a'.repeat(64) },
      { type: 'upload-write', chooser: 'c1', token: 'a'.repeat(64) },
      { type: 'upload-cancel', chooser: 'c1' },
      { type: 'upload-complete', chooser: 'c1' },
    ]) {
      expect(parseControl(message)).toEqual(message);
      expect(() => parseControl({ ...message, path: '/private/local.txt' })).toThrow();
      expect(() => parseControl({ ...message, chooser: '../other' })).toThrow();
    }
    for (const changes of [
      { name: '../private' },
      { size: 256 * 1024 * 1024 + 1 },
      { sha256: 'bad' },
      { path: '/private' },
    ]) {
      expect(() =>
        parseControl({ type: 'upload-offer', chooser: 'c1', offer: { ...offer, ...changes } }),
      ).toThrow();
    }
    expect(() => parseControl({ type: 'upload-write', chooser: 'c1', token: '' })).toThrow();
  });

  test('accepts every message type it defines', () => {
    const messages = [
      { type: 'create', request: 'r1', url: 'https://example.com/' },
      { type: 'ready', request: 'r1', session: 's1', generation: 1, token: 't0k3n' },
      { type: 'media', token: 't0k3n' },
      { type: 'attach', request: 'r2', session: 's1' },
      { type: 'detach' },
      { type: 'stop', request: 'r3' },
      { type: 'list', request: 'r4' },
      { type: 'viewport', epoch: 1, width: 1280, height: 720, cols: 160, rows: 45 },
      {
        type: 'input',
        seq: 0,
        generation: 1,
        epoch: 1,
        event: { kind: 'key', key: 'a', modifiers: ['ctrl'] },
      },
      {
        type: 'input',
        seq: 0,
        generation: 1,
        epoch: 1,
        event: { kind: 'key', key: 'a', up: true },
      },
      { type: 'input', seq: 1, generation: 1, epoch: 1, event: { kind: 'text', text: 'hi' } },
      {
        type: 'input',
        seq: 2,
        generation: 1,
        epoch: 1,
        event: { kind: 'pointer', action: 'down', x: 4, y: 2, button: 'left' },
      },
      {
        type: 'input',
        seq: 3,
        generation: 1,
        epoch: 1,
        event: { kind: 'wheel', x: 4, y: 2, dx: 0, dy: -3 },
      },
      { type: 'request', request: 'r5', tool: 'status', params: { capture: true } },
      { type: 'result', request: 'r5', value: [{ session: 's1' }] },
      { type: 'error', request: 'r5', code: 'busy', message: 'Another controller is attached' },
      { type: 'error', code: 'failed', message: 'Owner stopped' },
      { type: 'cancel', request: 'r5' },
      { type: 'surface', surface: 'toolbar', action: 'cover' },
      { type: 'credit', surface: 'content' },
      { type: 'heartbeat' },
      { type: 'file-chooser-unsupported' },
      {
        type: 'artifact',
        artifact: 'a1',
        action: 'offer',
        size: 1024,
        mime: 'image/png',
        hash: 'a'.repeat(64),
      },
      { type: 'artifact', artifact: 'a1', action: 'ack' },
      { type: 'artifact', artifact: 'a1', action: 'read', token: 't1' },
    ];
    for (const message of messages) expect(parseControl(message)).toEqual(message);
  });

  test('rejects malformed fields', () => {
    expect(() =>
      parseControl({ type: 'hello', version: 2, build: 'abc', codecs: ['jpeg'] }),
    ).toThrow();
    expect(() =>
      parseControl({ type: 'hello', version: 1, build: 'abc', codecs: ['jpeg', 'webp'] }),
    ).toThrow();
    expect(() => parseControl({ type: 'create', request: 'a b', url: 'https://a.b/' })).toThrow();
    expect(() =>
      parseControl({ type: 'create', request: 'r', url: 'file:///etc/passwd' }),
    ).toThrow();
    expect(() => parseControl({ type: 'create', request: 'r', url: 'not a url' })).toThrow();
    expect(() => parseControl({ type: 'create', request: 'r' })).toThrow();
    expect(() =>
      parseControl({ type: 'create', request: 'x'.repeat(65), url: 'https://a.b/' }),
    ).toThrow();
    expect(() => parseControl({ type: 'stop', request: 1 })).toThrow();
    expect(() =>
      parseControl({ type: 'viewport', epoch: 0, width: 0, height: 720, cols: 160, rows: 45 }),
    ).toThrow();
    expect(() =>
      parseControl({ type: 'viewport', epoch: 0, width: 1280, height: 720, cols: 160 }),
    ).toThrow();
    expect(() =>
      parseControl({
        type: 'input',
        seq: 1.5,
        generation: 1,
        epoch: 0,
        event: { kind: 'text', text: 'x' },
      }),
    ).toThrow();
    expect(() =>
      parseControl({
        type: 'input',
        seq: 1,
        generation: 1,
        epoch: 0,
        event: { kind: 'key', key: '' },
      }),
    ).toThrow();
    expect(() =>
      parseControl({
        type: 'input',
        seq: 1,
        generation: 1,
        epoch: 0,
        event: { kind: 'key', key: 'a', up: false },
      }),
    ).toThrow();
    expect(() =>
      parseControl({
        type: 'input',
        seq: 1,
        generation: 1,
        epoch: 0,
        event: { kind: 'pointer', action: 'down', x: 1, y: 1 },
      }),
    ).toThrow();
    expect(() =>
      parseControl({
        type: 'input',
        seq: 1,
        generation: 1,
        epoch: 0,
        event: { kind: 'wheel', x: 1, y: 1, dx: 0 },
      }),
    ).toThrow();
    expect(() =>
      parseControl({ type: 'request', request: 'r1', tool: 'status', params: { n: Number.NaN } }),
    ).toThrow();
    expect(() => parseControl({ type: 'result', request: 'r1', value: undefined })).toThrow();
    expect(() => parseControl({ type: 'error', code: 'exploded', message: 'x' })).toThrow();
    expect(() =>
      parseControl({
        type: 'artifact',
        artifact: 'a1',
        action: 'offer',
        size: 1,
        mime: 'image/png',
      }),
    ).toThrow();
    expect(() =>
      parseControl({ type: 'artifact', artifact: 'a1', action: 'read', token: 'bad token' }),
    ).toThrow();
    expect(() => parseControl({ type: 'surface', surface: 'page', action: 'create' })).toThrow();
    expect(() => parseControl(null)).toThrow();
  });
});

describe('media envelope', () => {
  test('round-trips metadata and payload', () => {
    const bytes = encodeMediaEnvelope(meta, new Uint8Array([1, 2, 3]));
    const [out] = [...decodeMediaEnvelope(bytes)];
    expect(out?.meta).toEqual(meta);
    expect([...(out?.payload ?? [])]).toEqual([1, 2, 3]);
  });
  test('rejects oversize lengths before allocating', () => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(LIMITS.mediaMeta + 1, 0);
    expect(() => [...decodeMediaEnvelope(header)]).toThrow();
    const payloadHeader = Buffer.alloc(8);
    payloadHeader.writeUInt32BE(2, 0);
    payloadHeader.writeUInt32BE(LIMITS.mediaPayload + 1, 4);
    expect(() => [...decodeMediaEnvelope(payloadHeader)]).toThrow();
  });
  test('rejects dimensions over the pixel cap', () => {
    expect(() =>
      encodeMediaEnvelope({ ...meta, width: 4096, height: 4096 }, new Uint8Array(1)),
    ).toThrow();
  });

  test('rejects invalid metadata JSON', () => {
    expect(() => [...decodeMediaEnvelope(envelope('{not json', new Uint8Array([1])))]).toThrow();
  });
  test('rejects extra metadata keys', () => {
    const json = JSON.stringify({ ...meta, extra: 1 });
    expect(() => [...decodeMediaEnvelope(envelope(json, new Uint8Array([1])))]).toThrow();
    expect(() =>
      encodeMediaEnvelope({ ...meta, extra: 1 } as MediaMeta, new Uint8Array([1])),
    ).toThrow();
  });
  test('rejects a wrong codec', () => {
    const json = JSON.stringify({ ...meta, codec: 'webp' });
    expect(() => [...decodeMediaEnvelope(envelope(json, new Uint8Array([1])))]).toThrow();
    expect(() =>
      encodeMediaEnvelope({ ...meta, codec: 'webp' } as unknown as MediaMeta, new Uint8Array([1])),
    ).toThrow();
  });
  test('rejects oversize payloads and truncated envelopes', () => {
    expect(() => encodeMediaEnvelope(meta, new Uint8Array(LIMITS.mediaPayload + 1))).toThrow();
    expect(() => encodeMediaEnvelope(meta, new Uint8Array(0))).toThrow();
    const bytes = encodeMediaEnvelope(meta, new Uint8Array([1, 2, 3]));
    expect(() => [...decodeMediaEnvelope(bytes.subarray(0, 4))]).toThrow();
    expect(() => [...decodeMediaEnvelope(Buffer.concat([bytes, bytes]))]).toThrow();
  });

  test('reassembles across arbitrary splits', () => {
    const payload = new Uint8Array([9, 8, 7, 6, 5]);
    const bytes = encodeMediaEnvelope(meta, payload);
    for (let split = 1; split < bytes.length; split += 1) {
      const decoder = new MediaDecoder();
      const frames = [
        ...decoder.push(bytes.subarray(0, split)),
        ...decoder.push(bytes.subarray(split)),
      ];
      expect(frames).toHaveLength(1);
      expect(frames[0]?.meta).toEqual(meta);
      expect(frames.map((frame) => [...frame.payload])).toEqual([[...payload]]);
    }
    const decoder = new MediaDecoder();
    const frames = [];
    for (const byte of bytes) frames.push(...decoder.push(Buffer.from([byte])));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.meta).toEqual(meta);
    expect(frames.map((frame) => [...frame.payload])).toEqual([[...payload]]);
  });

  test('decodes several envelopes from one chunk', () => {
    const first = encodeMediaEnvelope(meta, new Uint8Array([1]));
    const second = encodeMediaEnvelope(
      { ...meta, surface: 'toolbar', codec: 'png', frame: 8 },
      new Uint8Array([2]),
    );
    const frames = new MediaDecoder().push(Buffer.concat([first, second]));
    expect(frames.map((frame) => frame.meta.surface)).toEqual(['content', 'toolbar']);
    expect(frames.map((frame) => frame.meta.codec)).toEqual(['jpeg', 'png']);
    expect(frames.map((frame) => [...frame.payload])).toEqual([[1], [2]]);
  });
});

describe('clipboard control message', () => {
  test('accepts non-empty text up to 16 KiB of UTF-8 bytes', () => {
    expect(parseControl({ type: 'clipboard', text: 'copied' })).toEqual({
      type: 'clipboard',
      text: 'copied',
    });
    expect(parseControl({ type: 'clipboard', text: 'a'.repeat(LIMITS.clipboard) })).toMatchObject({
      type: 'clipboard',
    });
    // The cap counts bytes, so half as many two-byte characters are allowed.
    expect(
      parseControl({ type: 'clipboard', text: 'é'.repeat(LIMITS.clipboard / 2) }),
    ).toMatchObject({ type: 'clipboard' });
  });

  test('rejects empty, oversize and malformed clipboard text', () => {
    expect(() => parseControl({ type: 'clipboard', text: '' })).toThrow();
    expect(() =>
      parseControl({ type: 'clipboard', text: 'a'.repeat(LIMITS.clipboard + 1) }),
    ).toThrow();
    expect(() =>
      parseControl({ type: 'clipboard', text: 'é'.repeat(LIMITS.clipboard / 2 + 1) }),
    ).toThrow();
    expect(() => parseControl({ type: 'clipboard', text: 1 })).toThrow();
    expect(() => parseControl({ type: 'clipboard', text: 'a', extra: 1 })).toThrow();
  });
});

describe('external-link control message', () => {
  const link = (url: unknown) => parseControl({ type: 'external-link', url });

  test('accepts a canonical web URL', () => {
    expect(link('https://example.com/path?a=1')).toEqual({
      type: 'external-link',
      url: 'https://example.com/path?a=1',
    });
    expect(link('http://example.com/')).toEqual({
      type: 'external-link',
      url: 'http://example.com/',
    });
  });

  test('rejects other schemes and credentials', () => {
    expect(() => link('javascript:alert(1)')).toThrow();
    expect(() => link('file:///etc/passwd')).toThrow();
    expect(() => link('https://user:pw@example.com/')).toThrow();
    expect(() => link('https://user@example.com/')).toThrow();
  });

  test('rejects control characters and non-canonical URLs', () => {
    expect(() => link('https://example.com/\u0000')).toThrow();
    expect(() => link('https://example.com/\u009b2J')).toThrow();
    expect(() => link('https://example.com/ ')).toThrow();
    expect(() => link('HTTPS://example.com/')).toThrow();
  });

  test('caps the URL at 4096 UTF-8 bytes, not UTF-16 units', () => {
    const base = 'https://example.com/';
    const fits = base + 'a'.repeat(4096 - base.length);
    expect(link(fits)).toEqual({ type: 'external-link', url: fits });
    const multibyte = base + '\u00e9'.repeat(2048);
    expect(multibyte.length).toBeLessThan(4096);
    expect(() => link(multibyte)).toThrow();
    expect(() => link(`${fits}a`)).toThrow();
  });
});
