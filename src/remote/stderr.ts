import type { Readable } from 'node:stream';

/** SSH stderr can contain host-controlled text, not just trusted local diagnostics. */
export function relayRemoteStderr(
  source: Readable,
  write: (text: string) => void = (text) => {
    process.stderr.write(text);
  },
): void {
  // Decode across chunks before filtering: a split UTF-8 C1 control must not slip through.
  source.setEncoding('utf8');
  source.on('data', (text: string) => {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal security; keep LF only
    write(text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, ''));
  });
}
