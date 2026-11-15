import { EventEmitter } from 'node:events';
import { expect, test } from 'bun:test';
import { TerminalWriter } from './transport';

class Sink extends EventEmitter {
  writableLength = 0;
  blocked = false;
  destroyed = false;
  frames: Buffer[] = [];
  write(frame: Buffer): boolean {
    this.frames.push(frame);
    if (this.blocked) this.writableLength += frame.length;
    return !this.blocked;
  }
  destroy(): void {
    this.destroyed = true;
  }
}

test('backpressure pauses producer until drain', () => {
  const sink = new Sink();
  const writer = new TerminalWriter(sink);
  sink.blocked = true;
  expect(writer.writeOutput(Buffer.from('first'))).toBe(false);
  expect(writer.writeOutput(Buffer.from('second'))).toBe(false);
  expect(sink.frames).toHaveLength(1);
  let drains = 0;
  writer.onDrain(() => drains++);
  sink.blocked = false;
  sink.writableLength = 0;
  sink.emit('drain');
  expect(sink.frames).toHaveLength(2);
  expect(drains).toBe(1);
});

test('bounds total queue and closes only offending sink', () => {
  const slow = new Sink();
  slow.blocked = true;
  const fast = new Sink();
  const writer = new TerminalWriter(slow);
  const sibling = new TerminalWriter(fast);
  writer.writeOutput(Buffer.alloc(256 * 1024));
  writer.writeOutput(Buffer.alloc(256 * 1024));
  writer.writeOutput(Buffer.alloc(256 * 1024));
  writer.writeOutput(Buffer.alloc(256 * 1024));
  expect(slow.destroyed).toBe(true);
  expect(sibling.writeOutput(Buffer.from('healthy'))).toBe(true);
  expect(fast.destroyed).toBe(false);
});

test('splits large payload without modifying bytes', () => {
  const sink = new Sink();
  const writer = new TerminalWriter(sink);
  const data = Buffer.alloc(600 * 1024, 42);
  expect(writer.writeOutput(data)).toBe(true);
  expect(sink.frames).toHaveLength(3);
  expect(Buffer.concat(sink.frames.map((frame) => frame.subarray(5)))).toEqual(data);
});
