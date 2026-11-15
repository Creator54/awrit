import { expect, test } from 'bun:test';
import { createTerminalOutput, Mode } from './output';

test('interleaved output batches never cross terminals', () => {
  const a: string[] = [];
  const b: string[] = [];
  const left = createTerminalOutput((data) => a.push(data));
  const right = createTerminalOutput((data) => b.push(data));
  left.startBatch();
  left.write('left');
  right.write('right');
  right.startBatch();
  right.write('two');
  left.endBatch();
  right.endBatch();
  expect(a).toEqual(['left']);
  expect(b).toEqual(['right', 'two']);
});

test('nested batches flush only after the outer handoff finishes', () => {
  const writes: string[] = [];
  const output = createTerminalOutput(data => writes.push(data));
  output.startBatch();
  output.write('old');
  output.startBatch();
  output.write('replacement');
  output.endBatch();
  expect(writes).toEqual([]);
  output.write('retire');
  output.endBatch();
  expect(writes).toEqual(['oldreplacementretire']);
});

test('nested paints cannot release an outer synchronized replacement', () => {
  const writes: string[] = [];
  const output = createTerminalOutput(data => writes.push(data));
  output.startBatch();
  output.setModes([Mode.pendingUpdate], true);
  output.write('clear-old');
  output.setModes([Mode.pendingUpdate], true);
  output.write('restore-pixels');
  output.setModes([Mode.pendingUpdate], false);
  output.write('retire-old');
  output.setModes([Mode.pendingUpdate], false);
  output.endBatch();
  expect(writes).toEqual(['\x1b[?2026hclear-oldrestore-pixelsretire-old\x1b[?2026l']);
});

test('pane output retains title sanitization and local cleanup', () => {
  const a: string[] = [];
  const b: string[] = [];
  const left = createTerminalOutput((data) => a.push(data));
  const right = createTerminalOutput((data) => b.push(data));
  left.setTitle('title\x1b\x07');
  right.cleanup();
  expect(a).toEqual(['\x1b]2;title\x07']);
  expect(b.join('')).toContain('\x1b[?1049l');
});
