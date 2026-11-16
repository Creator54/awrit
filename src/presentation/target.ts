import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { LOOPBACK_ADDRESS } from '../loopback';
import { UsageError } from './usageError';

export type PresentationTarget =
  | { kind: 'file'; path: string; url: string }
  | { kind: 'url'; url: string };

/**
 * Checks if a string represents an explicit non-HTTP/file protocol scheme (e.g. ftp:, javascript:).
 * Distinguishes true URL schemes (e.g. "ftp://", "javascript:") from host:port combinations (e.g. "localhost:3000", "example.com:8080").
 */
function isDisallowedScheme(value: string): boolean {
  // A scheme starts with an ASCII letter, followed by letters, digits, plus, period, or hyphen, ending with colon
  const match = /^([a-z][a-z0-9+.-]*):/i.exec(value);
  if (!match) return false;
  const prefix = match[1].toLowerCase();
  if (prefix === 'http' || prefix === 'https' || prefix === 'file') return false;

  // If followed by digits and end of host or path (e.g. localhost:3000, 127.0.0.1:8080, example.com:8080),
  // it's a host:port, not a URI scheme.
  if (/^:\d+(?:\/.*)?$/.test(value.slice(prefix.length))) {
    return false;
  }

  // True scheme (e.g. ftp:, data:, mailto:, javascript:, git:)
  return true;
}

/**
 * Checks if a string looks like a web host or host:port rather than a local file path.
 * Common examples:
 * - example.com
 * - sub.example.co.uk/path
 * - localhost:3000
 * - 127.0.0.1:8080
 */
export function isLikelyWebHost(value: string): boolean {
  if (value.startsWith('/') || value.startsWith('./') || value.startsWith('../') || value.startsWith('~/')) {
    return false;
  }
  // Matches localhost or localhost:port (with optional /path or ?query)
  if (/^localhost(?::\d+)?(?:\/.*|\?.*)?$/i.test(value)) {
    return true;
  }
  // Matches IPv4 addresses (with optional :port and /path or ?query)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?(?:\/.*|\?.*)?$/.test(value)) {
    return true;
  }
  // Matches domain.tld (e.g. nixos.org, github.com/foo, example.com:8080?query=1)
  const domainMatch = /^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,})(?::\d+)?(?:\/.*|\?.*)?$/i.exec(
    value,
  );
  if (domainMatch) {
    const tld = domainMatch[2].toLowerCase();
    const commonFileExtensions = new Set([
      'html',
      'htm',
      'png',
      'jpg',
      'jpeg',
      'gif',
      'webp',
      'svg',
      'mp4',
      'mov',
      'm4v',
      'webm',
      'md',
      'txt',
      'json',
      'ts',
      'js',
      'css',
      'pdf',
      'zip',
      'py',
      'rs',
      'sh',
      'yaml',
      'yml',
    ]);
    if (!commonFileExtensions.has(tld)) {
      return true;
    }
    // If it has a subpath or query (e.g. example.com/page.html, site.org?p=1), it is a web URL.
    if (value.includes('/') || value.includes('?')) {
      return true;
    }
  }
  return false;
}

export function resolvePresentationTarget(value: string, cwd = process.cwd()): PresentationTarget {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: targets must not contain terminal controls
  if (!value || /[\x00-\x1f\x7f]/.test(value)) {
    throw new UsageError('Target must be nonempty and contain no control characters');
  }
  if (/^https?:\/\//i.test(value)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new UsageError('Target is not a valid URL');
    }
    if (url.username || url.password)
      throw new UsageError('URLs with embedded credentials are not allowed');
    return { kind: 'url', url: url.href };
  }
  if (/^file:/i.test(value)) {
    try {
      return localFile(fileURLToPath(new URL(value)));
    } catch (error) {
      if (error instanceof UsageError) throw error;
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        throw new UsageError(`File target does not exist: ${value}`);
      throw new UsageError('File target is not a valid file URL');
    }
  }
  const localPath = path.resolve(cwd, value);
  try {
    return localFile(localPath);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }

  // If it has an explicit non-http/file scheme (e.g. ftp:, javascript:), reject
  if (isDisallowedScheme(value)) {
    throw new UsageError('Target scheme must be http, https or file');
  }

  // If not a local file, check if it's a web host (e.g. nixos.org, localhost:3000)
  const loopback = LOOPBACK_ADDRESS.test(value);
  if (loopback || isLikelyWebHost(value)) {
    const protocol = loopback ? 'http' : 'https';
    return { kind: 'url', url: `${protocol}://${value}` };
  }

  throw new UsageError(
    `Local target does not exist: ${localPath}. Use an explicit HTTP(S) URL for a page.`,
  );
}

function localFile(candidate: string): PresentationTarget {
  const canonical = realpathSync(candidate);
  if (!statSync(canonical).isFile())
    throw new UsageError('Presentation target must be a regular file');
  return { kind: 'file', path: canonical, url: pathToFileURL(canonical).href };
}
