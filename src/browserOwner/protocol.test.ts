import { describe, expect, test } from 'bun:test';
import { encodeFrame, FrameDecoder } from './protocol';

describe('terminal frame protocol', () => {
  test('fragmented headers and coalesced frames preserve bytes', () => {
    const decoder = new FrameDecoder();
    const a = encodeFrame('control', Buffer.from('{"version":1}'));
    const b = encodeFrame('output', Buffer.from('\x1b_Ghello\x1b\\'));
    expect(decoder.push(a.subarray(0, 2))).toEqual([]);
    const frames = decoder.push(Buffer.concat([a.subarray(2), b]));
    expect(frames.map((frame) => frame.kind)).toEqual(['control', 'output']);
    expect(frames[1].payload.toString()).toBe('\x1b_Ghello\x1b\\');
  });
  test('rejects oversized control and output', () => {
    // Both caps are 256 KiB: control frames now carry tool results (text, snapshot).
    expect(() => encodeFrame('control', Buffer.alloc(262145))).toThrow();
    expect(() => encodeFrame('output', Buffer.alloc(262145))).toThrow();
    for (const [kind, size] of [
      [1, 262146],
      [2, 262146],
    ]) {
      const header = Buffer.alloc(5);
      header.writeUInt32BE(size);
      header[4] = kind;
      expect(() => new FrameDecoder().push(header)).toThrow();
    }
  });
  test('carries a large tool result on the control lane', () => {
    const payload = Buffer.from(
      JSON.stringify({ type: 'result', request: 'r1', value: 'x'.repeat(131_072) }),
    );
    const frames = new FrameDecoder().push(encodeFrame('control', payload));
    expect(frames[0]?.payload.equals(payload)).toBe(true);
  });
  test('rejects empty frame and unknown kind', () => {
    expect(() => new FrameDecoder().push(Buffer.alloc(4))).toThrow();
    const invalid = Buffer.from([0, 0, 0, 1, 3]);
    expect(() => new FrameDecoder().push(invalid)).toThrow();
  });
  test('bounded framing handles many frames in one chunk', () => {
    const frame = encodeFrame('output', Buffer.alloc(1024, 7));
    const frames = new FrameDecoder().push(Buffer.concat(Array(300).fill(frame)));
    expect(frames).toHaveLength(300);
    expect(frames.every((item) => item.payload.length === 1024)).toBe(true);
  });
});
