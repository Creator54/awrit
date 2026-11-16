import { StringDecoder } from 'node:string_decoder';

/** Highest TCP port number. */
const MAX_PORT = 65535;
/** Ignore an ssh stderr line longer than this instead of buffering it. */
const MAX_LINE = 512;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const ALLOCATED_LINE = /^Allocated port (\d{1,5}) for remote forward to 127\.0\.0\.1:(\d{1,5})$/;

function validPort(port: number): boolean {
  return Number.isSafeInteger(port) && port >= 1 && port <= MAX_PORT;
}

/** sshd reports the allocated port on stderr; anything else is ignored. */
export function allocatedForwardPort(line: string, localPort: number): number | undefined {
  const match = ALLOCATED_LINE.exec(line.replace(/\r$/, ''));
  if (!match) return undefined;
  const allocated = Number(match[1]);
  const forwarded = Number(match[2]);
  if (!validPort(allocated) || !validPort(forwarded) || forwarded !== localPort) return undefined;
  return allocated;
}

export interface ForwardPortScanner {
  /** Feeds one stderr chunk; returns the allocated port once the line arrives. */
  push(chunk: string | Buffer): number | undefined;
}

/**
 * Bounded line scanner for ssh stderr. A hostile host can send noise or an
 * unterminated line, so incomplete text is capped and dropped at the next newline.
 */
export function createForwardPortScanner(localPort: number): ForwardPortScanner {
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let discarding = false;
  let found: number | undefined;
  return {
    push(chunk) {
      if (found !== undefined) return undefined;
      let text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
      while (text.length) {
        const newline = text.indexOf('\n');
        if (newline === -1) {
          if (!discarding) {
            buffer += text;
            if (buffer.length > MAX_LINE) {
              buffer = '';
              discarding = true;
            }
          }
          break;
        }
        const piece = text.slice(0, newline);
        text = text.slice(newline + 1);
        const line = discarding ? undefined : `${buffer}${piece}`.replace(/\r$/, '');
        buffer = '';
        discarding = false;
        if (line === undefined || line.length > MAX_LINE) continue;
        const port = allocatedForwardPort(line, localPort);
        if (port !== undefined) {
          found = port;
          return port;
        }
      }
      return undefined;
    },
  };
}

/** The page keeps its scheme, path, query and hash; only loopback host and port change. */
export function forwardedUrl(url: string, allocatedPort: number): string {
  if (!validPort(allocatedPort)) throw new Error('Invalid forwarded port');
  const parsed = new URL(url);
  parsed.hostname = '127.0.0.1';
  parsed.port = String(allocatedPort);
  return parsed.toString();
}

export function isLoopbackUrl(url: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * A remote browser can only reach a local service through an ssh forward. The
 * page must be the loopback page on that same port, so origin stays the same.
 */
export function validateForwardUrl(url: string, port: number): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('--forward needs an http or https URL on localhost');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new Error('--forward needs an http or https URL on localhost');
  if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1')
    throw new Error(
      '--forward requires localhost or 127.0.0.1 and a service listening on IPv4 loopback',
    );
  const pagePort =
    parsed.port === '' ? (parsed.protocol === 'http:' ? 80 : 443) : Number(parsed.port);
  if (pagePort !== port)
    throw new Error(`--forward ${port} does not match the URL port ${pagePort}`);
  return url;
}

/** Plain words for the prompt; the user has to accept this before a tunnel opens. */
export function forwardConsentText(alias: string, url: string, port: number): string {
  return [
    `Forward local port ${port} to ${alias} while this page is open?`,
    `The page will use ${JSON.stringify(url)} on ${alias}`,
    'as 127.0.0.1 on a port chosen by ssh.',
    `The local service must listen on 127.0.0.1:${port}.`,
    `Any processes on ${alias} can reach your service there, but it is not open to the internet.`,
    `On ${alias}, localhost normally means that host, not this machine.`,
  ].join('\n');
}
