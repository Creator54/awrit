import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
const prelude = source.slice(
  source.indexOf('    function registerPaints(size:'),
  source.indexOf('      if (hasAnimation) {', source.indexOf('    function registerPaints(size:')),
).replace('size: WindowDimensions', 'size');

for (const active of [true, false]) {
  test(`paint registration clears stale tab placements only for the active page (${active})`, () => {
    const events: string[] = [];
    const context = {
      destructors: [() => events.push('dispose-own')],
      refreshers: [() => {}],
      noPaint: false,
      isActive: () => active,
      graphics: { clearPlacements: () => events.push('clear-pane') },
      clearPlacements: () => { throw new Error('must use this terminal output'); },
    };
    vm.runInNewContext(`${prelude}} registerPaints({});`, context);
    expect(events).toEqual(active ? ['dispose-own', 'clear-pane'] : ['dispose-own']);
  });
}
