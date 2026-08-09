import { describe, expect, test } from 'bun:test';
import { generateCrashPage, generateErrorPage } from './errorPage';

describe('built-in recovery pages', () => {
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
});
