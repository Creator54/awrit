import { describe, expect, test } from 'bun:test';
import { generateCrashPage, generateErrorPage } from './errorPage';

describe('built-in recovery pages', () => {
  test('distinguish missing local files from refused network connections', () => {
    const file = generateErrorPage({
      errorCode: -6,
      errorDescription: 'ERR_FILE_NOT_FOUND',
      failedUrl: 'file:///missing.html',
    });
    const connection = generateErrorPage({
      errorCode: -102,
      errorDescription: 'ERR_CONNECTION_REFUSED',
      failedUrl: 'http://127.0.0.1:1/',
    });
    expect(file).toContain('<h1>File not found</h1>');
    expect(connection).toContain('<h1>Connection refused</h1>');
  });

  test('name an untrusted certificate instead of a generic failure', () => {
    const page = generateErrorPage({
      errorCode: -202,
      errorDescription: 'ERR_CERT_AUTHORITY_INVALID',
      failedUrl: 'https://127.0.0.1:45013/',
    });
    expect(page).toContain('<h1>Certificate not trusted</h1>');
  });

  test('escape diagnostics and URLs before inserting them into HTML and scripts', () => {
    const payload = '</script><img src=x onerror=alert(1)>';
    const pages = [
      generateErrorPage({ errorCode: -2, errorDescription: payload, failedUrl: payload }),
      generateCrashPage({ reason: payload, exitCode: 1, failedUrl: payload }),
    ];
    for (const html of pages) {
      expect(html).not.toContain(payload);
      expect(html).toContain('&lt;/script&gt;&lt;img');
      expect(html).toContain('var url = "\\u003c/script>');
    }
  });
  test('use only the narrow bridge actions with the failed URL', () => {
    const failedUrl = 'https://example.com/path?value=1&next=2';
    const pages = [
      generateErrorPage({ errorCode: -2, errorDescription: 'failed', failedUrl }),
      generateCrashPage({ reason: 'crashed', exitCode: 1, failedUrl }),
    ];

    for (const html of pages) {
      expect(html).toContain(`var url = ${JSON.stringify(failedUrl)}`);
      expect(html).toContain('window.awrit.goBack()');
      expect(html).toContain('window.awrit.openExternal(url)');
      expect(html).toContain('location.href = url');
      expect(html).not.toContain('location.reload()');
      expect(html).not.toContain('window.awrit.ipc');
      expect(html).not.toContain('awrit:open-external-current');
    }
  });
  test('share quiet recovery controls and hide unavailable actions', () => {
    const pages = [
      generateErrorPage({
        errorCode: -6,
        errorDescription: 'missing',
        failedUrl: 'file:///missing',
      }),
      generateCrashPage({ reason: 'crashed', exitCode: 1, failedUrl: 'file:///missing' }),
    ];
    for (const html of pages) {
      expect(html).toContain('<details><summary>Details</summary>');
      expect(html).toContain('retryButton.focus()');
      expect(html).not.toContain('id="awrit-external"');
      expect(html).not.toContain('animation:');
      expect(html).toContain('outline: 2px solid');
    }
  });

  test('retry asks the main process to reload the failed address', () => {
    const pages = [
      generateErrorPage({ errorCode: -6, errorDescription: 'missing', failedUrl: 'file:///tmp/missing.html' }),
      generateCrashPage({ reason: 'crashed', exitCode: 1, failedUrl: 'file:///tmp/missing.html' }),
    ];
    for (const html of pages) {
      expect(html).toContain('if (window.awrit && window.awrit.retry) window.awrit.retry();');
      expect(html).toContain('else location.href = url;');
    }
  });
});
