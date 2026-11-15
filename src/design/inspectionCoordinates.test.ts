import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

test('element inspection maps toolbar CSS coordinates using zoom, not display DPR', () => {
  const source = readFileSync(new URL('../windows.ts', import.meta.url), 'utf8');
  const handler = source.slice(source.indexOf('const onInspectElementAtPoint ='));
  const script = handler.match(/const script = `([\s\S]*?)`;/)?.[1];
  if (!script) throw new Error('Inspection script not found');
  for (const zoom of [1, 2]) {
    let inspected: number[] = [];
    const rendered = script.replaceAll(/\$\{x\}/g, '120').replaceAll(/\$\{y\}/g, '80')
      .replaceAll(/\$\{inspectionScale\}/g, String(zoom)).replaceAll(/\$\{up\}/g, '0');
    vm.runInNewContext(rendered, {
      window: { devicePixelRatio: 2 * zoom, innerWidth: 800, innerHeight: 600 },
      document: {
        elementsFromPoint: (x: number, y: number) => { inspected = [x, y]; return []; },
        elementFromPoint: () => null,
      },
    });
    expect(inspected).toEqual([120 / zoom, 80 / zoom]);
  }
});
