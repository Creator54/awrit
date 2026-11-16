import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../config.js', import.meta.url), 'utf8');
const zoomSource = source.slice(
  source.indexOf('// Zoom limits'),
  source.indexOf('\nconst config =', source.indexOf('// Zoom limits')),
);

for (const [action, initial, expected] of [
  ['zoomIn', 1, 1.1],
  ['zoomOut', 1.5, 1.4],
  ['zoomReset', 1.5, 1],
  ['zoomIn', 2, 2],
  ['zoomOut', 0.5, 0.5],
] as const) {
  test(`${action} publishes actual zoom ${initial} → ${expected} to an open omnibox`, () => {
    let zoom = initial as number;
    const sent: unknown[][] = [];
    const context = vm.createContext({
      URL,
      console,
      path: { join: (...parts: string[]) => parts.join('/') },
      os: { homedir: () => '/isolated' },
      fs: { existsSync: () => true, readFileSync: () => '{}', writeFileSync() {} },
      view: {
        omniboxVisible: true,
        content: {
          webContents: {
            getURL: () => 'https://example.com',
            getZoomFactor: () => zoom,
            setZoomFactor: (value: number) => {
              zoom = value;
            },
          },
        },
        toolbar: { webContents: { send: (...args: unknown[]) => sent.push(args) } },
      },
    });
    vm.runInContext(`${zoomSource}\n${action}({view});`, context);
    expect(zoom).toBeCloseTo(expected);
    expect(sent).toEqual([['content:zoom-changed', zoom]]);
  });
}
