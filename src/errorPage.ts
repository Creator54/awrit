/**
 * Error page template for network/connection failures.
 * Rendered when a page fails to load (did-fail-load).
 */

interface ErrorPageOptions {
  errorCode: number;
  errorDescription: string;
  failedUrl: string;
}

const ERROR_MESSAGES: Record<number, { title: string; tips: string[] }> = {
  [-2]: {
    title: 'Network Error',
    tips: ['Check your internet connection', 'Try again in a moment'],
  },
  [-3]: {
    // ERR_ABORTED — intentionally navigated away, don't show error
    title: '',
    tips: [],
  },
  [-6]: {
    title: 'Connection Refused',
    tips: [
      'The server refused the connection',
      'Check if the site is running on the correct port',
      'A firewall may be blocking the connection',
    ],
  },
  [-7]: {
    title: 'Connection Timed Out',
    tips: [
      'The server took too long to respond',
      'Check your internet connection',
      'The server may be overloaded',
    ],
  },
  [-21]: {
    title: 'Network Changed',
    tips: ['Your network connection changed', 'Try reloading the page'],
  },
  [-100]: {
    title: 'Connection Closed',
    tips: ['The connection was unexpectedly closed', 'Try reloading the page'],
  },
  [-101]: {
    title: 'Connection Reset',
    tips: [
      'The connection was reset',
      'Check your internet connection',
      'A proxy or firewall may be interfering',
    ],
  },
  [-102]: {
    title: 'Connection Refused',
    tips: [
      'The server refused the connection',
      'Make sure the server is running',
      'Check the port number',
    ],
  },
  [-105]: {
    title: 'DNS Lookup Failed',
    tips: [
      'Could not resolve the domain name',
      'Check your DNS settings',
      'The domain may not exist',
    ],
  },
  [-106]: {
    title: 'No Internet',
    tips: [
      'You appear to be offline',
      'Check your network cable or Wi-Fi',
      'Try reconnecting to your network',
    ],
  },
  [-109]: {
    title: 'Address Unreachable',
    tips: [
      'The server address is unreachable',
      'Check the URL for typos',
      'The server may be down',
    ],
  },
  [-118]: {
    title: 'Connection Timed Out',
    tips: [
      'The connection attempt timed out',
      'The server may be slow or unresponsive',
      'Check your internet connection',
    ],
  },
  [-130]: {
    title: 'Proxy Connection Failed',
    tips: [
      'Could not connect through the proxy',
      'Check your proxy settings',
      'Try connecting directly',
    ],
  },
  [-137]: {
    title: 'DNS Lookup Failed',
    tips: [
      'Could not resolve the domain name',
      'Your DNS server may be down',
      'Try using a different DNS server (e.g. 1.1.1.1)',
    ],
  },
  [-200]: {
    title: 'Certificate Error',
    tips: [
      'The site\'s security certificate is not trusted',
      'The certificate may have expired',
      'Proceed with caution',
    ],
  },
  [-201]: {
    title: 'Certificate Date Invalid',
    tips: [
      'The security certificate has expired or is not yet valid',
      'Check that your system clock is correct',
    ],
  },
  [-300]: {
    title: 'Invalid URL',
    tips: ['The URL is not valid', 'Check for typos in the address'],
  },
  [-301]: {
    title: 'Unknown URL Scheme',
    tips: [
      'The URL uses an unsupported protocol',
      'awrit supports http://, https://, and file:// URLs',
    ],
  },
  [-324]: {
    title: 'Empty Response',
    tips: [
      'The server returned no data',
      'The server may be misconfigured',
      'Try again later',
    ],
  },
};

/**
 * Returns true if this error code should be silently ignored
 * (e.g., navigation aborts that are intentional).
 */
export function shouldIgnoreError(errorCode: number): boolean {
  // ERR_ABORTED (-3) is fired when navigation is intentionally cancelled
  // (e.g., by clicking a link before the page finishes loading)
  return errorCode === -3;
}

/**
 * Generates an HTML error page string for the given error.
 */
export function generateErrorPage({ errorCode, errorDescription, failedUrl }: ErrorPageOptions): string {
  const info = ERROR_MESSAGES[errorCode] || {
    title: 'Page Load Failed',
    tips: ['An unexpected error occurred', 'Try reloading the page'],
  };

  // Sanitize the URL for safe display
  const displayUrl = failedUrl
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  const tipsHtml = info.tips
    .map((tip) => `<li>${tip}</li>`)
    .join('\n            ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Error — ${info.title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    
    body {
      background: #0a0a0b;
      color: #e4e4e7;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .container {
      max-width: 480px;
      width: 90%;
      text-align: center;
      padding: 40px 32px;
    }

    .icon {
      width: 64px;
      height: 64px;
      margin: 0 auto 24px;
      border-radius: 50%;
      background: rgba(239, 68, 68, 0.1);
      border: 1px solid rgba(239, 68, 68, 0.2);
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .icon svg {
      width: 28px;
      height: 28px;
      color: #ef4444;
    }

    h1 {
      font-size: 22px;
      font-weight: 600;
      color: #fafafa;
      margin-bottom: 8px;
      letter-spacing: -0.02em;
    }

    .url {
      font-size: 13px;
      color: #71717a;
      margin-bottom: 28px;
      word-break: break-all;
      font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.06);
      border-radius: 6px;
      padding: 8px 12px;
      display: inline-block;
      max-width: 100%;
    }

    .tips {
      text-align: left;
      margin: 0 auto 32px;
      max-width: 360px;
    }

    .tips-label {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: #52525b;
      margin-bottom: 12px;
      font-weight: 500;
    }

    .tips ul {
      list-style: none;
      padding: 0;
    }

    .tips li {
      font-size: 14px;
      color: #a1a1aa;
      padding: 6px 0;
      padding-left: 20px;
      position: relative;
      line-height: 1.5;
    }

    .tips li::before {
      content: '›';
      position: absolute;
      left: 4px;
      color: #3f3f46;
      font-weight: bold;
    }

    .actions {
      display: flex;
      gap: 10px;
      justify-content: center;
    }

    .btn {
      padding: 9px 20px;
      border-radius: 8px;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: rgba(255, 255, 255, 0.05);
      color: #e4e4e7;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      font-family: inherit;
      outline: none;
    }

    .btn:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.15);
    }

    .btn:active {
      transform: scale(0.97);
    }

    .btn-primary {
      background: rgba(59, 130, 246, 0.15);
      border-color: rgba(59, 130, 246, 0.3);
      color: #93c5fd;
    }

    .btn-primary:hover {
      background: rgba(59, 130, 246, 0.25);
      border-color: rgba(59, 130, 246, 0.4);
    }

    .error-code {
      margin-top: 32px;
      font-size: 11px;
      color: #3f3f46;
      font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10"></circle>
        <line x1="12" y1="8" x2="12" y2="12"></line>
        <line x1="12" y1="16" x2="12.01" y2="16"></line>
      </svg>
    </div>

    <h1>${info.title}</h1>

    <div class="url">${displayUrl}</div>

    <div class="tips">
      <div class="tips-label">Things to try</div>
      <ul>
        ${tipsHtml}
      </ul>
    </div>

    <div class="actions">
      <button class="btn" onclick="history.back()">Go Back</button>
      <button class="btn btn-primary" onclick="location.reload()">Retry</button>
    </div>

    <div class="error-code">${errorDescription} (${errorCode})</div>
  </div>
</body>
</html>`;
}

/**
 * Generates an HTML page for renderer crashes.
 */
export function generateCrashPage(details: { reason: string; exitCode: number }): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Page Crashed</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #0a0a0b;
      color: #e4e4e7;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .container {
      max-width: 420px;
      width: 90%;
      text-align: center;
      padding: 40px 32px;
    }
    .icon {
      width: 64px;
      height: 64px;
      margin: 0 auto 24px;
      border-radius: 50%;
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.2);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 28px;
    }
    h1 {
      font-size: 22px;
      font-weight: 600;
      color: #fafafa;
      margin-bottom: 12px;
    }
    p {
      font-size: 14px;
      color: #a1a1aa;
      margin-bottom: 28px;
      line-height: 1.6;
    }
    .btn {
      padding: 9px 20px;
      border-radius: 8px;
      border: 1px solid rgba(59, 130, 246, 0.3);
      background: rgba(59, 130, 246, 0.15);
      color: #93c5fd;
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: all 0.15s ease;
      font-family: inherit;
    }
    .btn:hover {
      background: rgba(59, 130, 246, 0.25);
    }
    .error-code {
      margin-top: 24px;
      font-size: 11px;
      color: #3f3f46;
      font-family: monospace;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="icon">💥</div>
    <h1>Page Crashed</h1>
    <p>Something went wrong and this page couldn't continue running. This is usually temporary.</p>
    <button class="btn" onclick="location.reload()">Reload Page</button>
    <div class="error-code">${details.reason} (exit ${details.exitCode})</div>
  </div>
</body>
</html>`;
}
