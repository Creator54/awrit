import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('Kitty animation canvas includes scaled device-pixel frame bounds', () => {
  const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
  const start = source.indexOf('        // Kitty canvas dimensions');
  const end = source.indexOf('        // Content layer', start);
  const context = vm.createContext({
    size: { width: 1902, height: 1173 },
    contentNode: { deviceLayout: { x: 0, y: 0, width: 1989, height: 1225 } },
    toolbarNode: { deviceLayout: { x: 0, y: 0, width: 1989, height: 1225 } },
  });
  vm.runInContext(source.slice(start, end), context);
  expect(vm.runInContext('size', context)).toEqual({ width: 1989, height: 1225 });
});
