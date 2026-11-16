import { describe, expect, test } from 'bun:test';
import { connectionOf, permissionChoice } from './siteInfo';

describe('connectionOf', () => {
  test('classifies web and non-web pages', () => {
    expect(connectionOf('https://example.com/a')).toBe('secure');
    expect(connectionOf('http://example.com')).toBe('insecure');
    expect(connectionOf('file:///tmp/a.html')).toBe('local');
    expect(connectionOf('about:blank')).toBe('local');
    expect(connectionOf('')).toBe('local');
  });
});

describe('permissionChoice', () => {
  test('maps stored values to ask, allow or block', () => {
    expect(permissionChoice(undefined)).toBe('ask');
    expect(permissionChoice(true)).toBe('allow');
    expect(permissionChoice('video,audio')).toBe('allow');
    expect(permissionChoice(false)).toBe('block');
  });
});
