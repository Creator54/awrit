import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { relayRemoteStderr } from './stderr';

test('remote stderr preserves Unicode and lines but cannot control the terminal', async () => {
  const source = new PassThrough();
  const chunks: string[] = [];
  relayRemoteStderr(source, (text) => chunks.push(text));
  const bytes = Buffer.from('café\n\x1b]52;c;secret\x07\r\u009b2Jdone\n');
  source.write(bytes.subarray(0, 4));
  source.write(bytes.subarray(4, 8));
  source.end(bytes.subarray(8));
  await new Promise<void>((resolve) => source.on('end', resolve));
  expect(chunks.join('')).toBe('café\n]52;c;secret2Jdone\n');
});
