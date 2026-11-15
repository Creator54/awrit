import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./session.ts', import.meta.url), 'utf8');
const start = source.indexOf("ipcMain.handle('awrit:clear-site-cookies'");
const end = source.indexOf('\n\nipcMain.on(', start);
expect(start).toBeGreaterThanOrEqual(0);
expect(end).toBeGreaterThan(start);
const code = new Bun.Transpiler({ loader: 'ts' }).transformSync(source.slice(start, end));

function clear(cookies: { get: () => Promise<Array<{ name: string }>>; remove: () => Promise<void> }) {
  let handler!: (event: { sender: object }, url: string) => Promise<number>;
  new Function('ipcMain', 'senderSession', code)(
    { handle: (_name: string, fn: typeof handler) => { handler = fn; } }, () => ({ cookies }),
  );
  return handler({ sender: {} }, 'https://example.com');
}

test('cookie deletion failure is not reported as zero remaining cookies', async () => {
  await expect(clear({ get: async () => [{ name: 'session' }], remove: async () => { throw new Error('Disk failure'); } }))
    .rejects.toThrow('Could not clear cookies');
});

test('cookie deletion returns the actual remaining count', async () => {
  let removed = false;
  expect(await clear({ get: async () => removed ? [] : [{ name: 'session' }], remove: async () => { removed = true; } })).toBe(0);
});
