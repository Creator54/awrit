import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// Exercise credit accounting without loading the native graphics module.
function fixture(enabled = true) {
  let retain!: (id: number, buffer: object) => void;
  let now = 10;
  const samples: Array<{ stage: string; startedAt: number }> = [];
  const source = readFileSync(new URL('./context.ts', import.meta.url), 'utf8')
    .replace(/^import .*;\n/gm, '')
    .replace('export function', 'function')
    .replace(/^export type .*;\n/gm, '');
  const context = vm.createContext({
    createTerminalOutput: () => ({}),
    createTerminalGraphics: (_output: object, callback: typeof retain) => { retain = callback; return {}; },
    frameTrace: {
      enabled,
      now: () => now,
      record: (stage: string, startedAt: number) => samples.push({ stage, startedAt }),
    },
  });
  vm.runInContext(new Bun.Transpiler({ loader: 'ts' }).transformSync(source), context);
  const terminal = vm.runInContext('createTerminalContext("test", {}, {}, () => {}, {})', context);
  return { terminal, samples, retain: (id: number) => retain(id, {}), advance: () => { now += 20; } };
}

test('ACK timing follows each retained transfer and ignores unknown or duplicate ACKs', () => {
  const f = fixture();
  f.retain(1);
  f.advance();
  f.retain(2);
  f.terminal.acknowledgeGraphics('i=99');
  expect(f.samples).toEqual([]);
  f.terminal.acknowledgeGraphics('i=2');
  f.terminal.acknowledgeGraphics('i=2');
  f.terminal.acknowledgeGraphics('i=1');
  expect(f.samples).toEqual([{ stage: 'ack', startedAt: 30 }, { stage: 'ack', startedAt: 10 }]);
});

test('disabled tracing preserves credit accounting and dispose clears pending transfers', () => {
  const f = fixture(false);
  for (let i = 1; i <= 4; i++) f.retain(i);
  expect(f.terminal.canPaint()).toBe(false);
  f.terminal.acknowledgeGraphics('i=1');
  expect(f.terminal.canPaint()).toBe(true);
  expect(f.samples).toEqual([]);
  f.terminal.dispose();
  f.terminal.acknowledgeGraphics('i=2');
  expect(f.terminal.canPaint()).toBe(false);
  expect(f.samples).toEqual([]);
});
