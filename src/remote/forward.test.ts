import { describe, expect, test } from 'bun:test';
import {
  allocatedForwardPort,
  createForwardPortScanner,
  forwardConsentText,
  forwardedUrl,
  isLoopbackUrl,
  validateForwardUrl,
} from './forward';

describe('allocatedForwardPort', () => {
  test('reads the sshd line for the requested local port', () => {
    expect(
      allocatedForwardPort('Allocated port 41000 for remote forward to 127.0.0.1:3000', 3000),
    ).toBe(41000);
    expect(
      allocatedForwardPort('Allocated port 41000 for remote forward to 127.0.0.1:3000\r', 3000),
    ).toBe(41000);
  });
  test('ignores other ports, junk and out-of-range numbers', () => {
    for (const line of [
      'Allocated port 41000 for remote forward to 127.0.0.1:3001',
      'Allocated port 0 for remote forward to 127.0.0.1:3000',
      'Allocated port 99999 for remote forward to 127.0.0.1:3000',
      'Allocated port 41000 for remote forward to 0.0.0.0:3000',
      'Warning: Permanently added host to the list of known hosts.',
      'Allocated port 41000 for remote forward to 127.0.0.1:3000 trailing',
      '',
    ])
      expect(allocatedForwardPort(line, 3000)).toBeUndefined();
  });
});

describe('createForwardPortScanner', () => {
  test('assembles the line from split UTF-8 chunks', () => {
    const scanner = createForwardPortScanner(3000);
    expect(scanner.push(Buffer.from('café\r\nAllocated port 41'))).toBeUndefined();
    expect(scanner.push(Buffer.from('000 for remote'))).toBeUndefined();
    expect(scanner.push(Buffer.from(' forward to 127.0.0.1:3000\n'))).toBe(41000);
    // The port is reported once; later lines cannot change it.
    expect(
      scanner.push(Buffer.from('Allocated port 42000 for remote forward to 127.0.0.1:3000\n')),
    ).toBeUndefined();
  });
  test('bounds an unterminated hostile line without losing the next one', () => {
    const scanner = createForwardPortScanner(3000);
    expect(scanner.push('x'.repeat(10_000))).toBeUndefined();
    expect(scanner.push('\nAllocated port 41000 for remote forward to 127.0.0.1:3000\n')).toBe(
      41000,
    );
  });
});

describe('forwardedUrl', () => {
  test('keeps scheme, path, query and hash but points at the allocated loopback port', () => {
    expect(forwardedUrl('http://localhost:3000/a/b?q=1#frag', 41000)).toBe(
      'http://127.0.0.1:41000/a/b?q=1#frag',
    );
    expect(forwardedUrl('https://[::1]:3000/', 41001)).toBe('https://127.0.0.1:41001/');
    expect(forwardedUrl('http://127.0.0.1:3000/', 41002)).toBe('http://127.0.0.1:41002/');
  });
  test('rejects an invalid allocated port', () => {
    expect(() => forwardedUrl('http://localhost:3000/', 0)).toThrow();
    expect(() => forwardedUrl('http://localhost:3000/', 65536)).toThrow();
  });
});

describe('validateForwardUrl', () => {
  test('accepts a loopback page on the forwarded port', () => {
    for (const url of [
      'http://localhost:3000/',
      'http://127.0.0.1:3000/a?b=1',
      'https://localhost:3000/',
    ])
      expect(validateForwardUrl(url, 3000)).toBe(url);
  });
  test('accepts the default http and https ports', () => {
    expect(validateForwardUrl('http://localhost/', 80)).toBe('http://localhost/');
    expect(validateForwardUrl('https://127.0.0.1/x', 443)).toBe('https://127.0.0.1/x');
  });
  test('rejects a page that is not loopback http or https', () => {
    for (const url of [
      'http://example.com:3000/',
      'http://192.168.1.2:3000/',
      'http://0.0.0.0:3000/',
      'http://[::1]:3000/',
      'file:///tmp/x',
      'about:blank',
      'not a url',
    ])
      expect(() => validateForwardUrl(url, 3000)).toThrow();
  });
  test('rejects a port that does not match the page', () => {
    expect(() => validateForwardUrl('http://localhost:3000/', 3001)).toThrow();
    expect(() => validateForwardUrl('https://localhost/', 80)).toThrow();
    expect(() => validateForwardUrl('http://localhost:80/', 443)).toThrow();
  });
});

describe('isLoopbackUrl', () => {
  test('spots loopback pages and ignores anything else', () => {
    expect(isLoopbackUrl('http://localhost:3000/')).toBe(true);
    expect(isLoopbackUrl('https://127.0.0.1/')).toBe(true);
    expect(isLoopbackUrl('http://[::1]:8080/')).toBe(true);
    expect(isLoopbackUrl('http://example.com/')).toBe(false);
    expect(isLoopbackUrl('not a url')).toBe(false);
  });
});

describe('forwardConsentText', () => {
  test('names the host, port and exposure without promising privacy', () => {
    const text = forwardConsentText('phoenix', 'http://localhost:3000/', 3000);
    expect(text).toContain('3000');
    expect(text).toContain('phoenix');
    expect(text).toContain('processes on phoenix');
    expect(text).toContain('internet');
    expect(text.toLowerCase()).toContain('localhost');
  });
});
