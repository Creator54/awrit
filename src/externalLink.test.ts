import { expect, test } from 'bun:test';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./windows.ts', import.meta.url), 'utf8');
const handler = source.slice(
  source.indexOf('    const onOpenExternal = '),
  source.indexOf('    const onCopyToClipboard = '),
);

test('remote external link callback takes precedence over the host opener', () => {
  const forwarded: string[] = [];
  const opened: string[] = [];
  const context = vm.createContext({
    URL,
    console_: { log() {}, error() {} },
    content: { webContents: {} },
    windowOptions: { onOpenExternal: (url: string) => forwarded.push(url) },
    shell: {
      openExternal: async (url: string) => {
        opened.push(url);
      },
    },
  });
  // Strip only the handler's TS annotations; execute the actual branch rather than a copy.
  vm.runInContext(
    handler
      .replace('event: IpcMainEvent, value: unknown', 'event, value')
      .replace('let url: URL;', 'let url;') + '\nthis.invoke = onOpenExternal;',
    context,
  );
  vm.runInContext(
    "invoke({sender:content.webContents}, 'https://example.com/'); invoke({sender:content.webContents}, 'javascript:alert(1)');",
    context,
  );
  expect(forwarded).toEqual(['https://example.com/']);
  expect(opened).toEqual([]);
});
