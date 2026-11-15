/**
 * Error page template for network/connection failures.
 * Rendered when a page fails to load (did-fail-load).
 */

interface ErrorPageOptions {
  errorCode: number;
  errorDescription: string;
  failedUrl: string;
}

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[char] ?? char,
  );

const scriptString = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c');

const ERROR_MESSAGES: Record<number, { title: string; message: string }> = {
  [-2]: {
    title: 'Network error',
    message: 'Check your internet connection, then retry.',
  },
  [-3]: {
    // ERR_ABORTED — intentionally navigated away, don't show error
    title: '',
    message: '',
  },
  [-6]: {
    title: 'File not found',
    message: 'Check the file path.',
  },
  [-7]: {
    title: 'Site took too long',
    message: 'Check your connection or try again later.',
  },
  [-21]: {
    title: 'Network changed',
    message: 'Try again with your current connection.',
  },
  [-100]: {
    title: 'Connection closed',
    message: 'Try again in a moment.',
  },
  [-101]: {
    title: 'Connection interrupted',
    message: 'Check your internet connection, then retry.',
  },
  [-102]: {
    title: 'Connection refused',
    message: 'Check the address and make sure the server is running.',
  },
  [-105]: {
    title: "Can't find this site",
    message: 'Check the address and your internet connection.',
  },
  [-106]: {
    title: 'No internet',
    message: 'Reconnect to the internet, then retry.',
  },
  [-109]: {
    title: 'Site unreachable',
    message: 'Check the address or try again later.',
  },
  [-118]: {
    title: 'Site took too long',
    message: 'Check your connection or try again later.',
  },
  [-130]: {
    title: 'Proxy unavailable',
    message: 'Check your proxy settings.',
  },
  [-137]: {
    title: "Can't find this site",
    message: 'Check the address and your internet connection.',
  },
  [-200]: {
    title: 'Certificate error',
    message: "The site's security certificate is not trusted. The certificate may have expired.",
  },
  [-201]: {
    title: 'Invalid certificate dates',
    message:
      'The security certificate has expired or is not yet valid. Check that your system clock is correct.',
  },
  [-202]: {
    title: 'Certificate not trusted',
    message: 'No trusted authority issued this certificate, as with a self-signed one.',
  },
  [-300]: {
    title: 'Invalid address',
    message: 'Check the address for typos.',
  },
  [-301]: {
    title: 'Unsupported address type',
    message: 'Use an http://, https://, or file:// address.',
  },
  [-324]: {
    title: 'Site sent no data',
    message: 'Try again later.',
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
export function generateErrorPage({
  errorCode,
  errorDescription,
  failedUrl,
}: ErrorPageOptions): string {
  const info = ERROR_MESSAGES[errorCode] || {
    title: 'Page could not load',
    message: 'Try again in a moment.',
  };

  return recoveryPage(info.title, info.message, failedUrl, `${errorDescription} (${errorCode})`);
}

export function generateCrashPage(details: {
  reason: string;
  exitCode: number;
  failedUrl: string;
}): string {
  return recoveryPage(
    'Page crashed',
    'Reload to continue.',
    details.failedUrl,
    `${details.reason} (exit ${details.exitCode})`,
  );
}

function recoveryPage(
  title: string,
  message: string,
  failedUrl: string,
  diagnostics: string,
): string {
  const canOpenExternal = /^https?:\/\//i.test(failedUrl);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; background: #1c1b22; color: #fbfbfe;
      font: 15px/1.6 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      min-height: 100vh; display: grid; place-items: center; padding: 24px; }
    main { width: min(100%, 480px); padding: 24px 0; }
    .icon { width: 28px; height: 28px; color: #adadb8; margin-bottom: 16px; }
    h1 { font-size: 24px; line-height: 1.3; font-weight: 600; margin: 0 0 12px; }
    p { color: #adadb8; margin: 0 0 20px; }
    .url { overflow-wrap: anywhere; font-size: 13px; margin-bottom: 24px; }
    .actions { display: flex; flex-wrap: wrap; gap: 8px; }
    button { font: inherit; font-size: 13px; min-height: 36px; padding: 6px 12px;
      border: 1px solid #646371; border-radius: 8px; background: transparent;
      color: #fbfbfe; cursor: pointer; }
    button:hover { background: #2b2a33; }
    .primary { color: #1c1b22; background: #fbfbfe; border-color: #fbfbfe; }
    .primary:hover { background: #dcdce5; border-color: #dcdce5; }
    button:focus-visible, summary:focus-visible { outline: 2px solid #9bc1ff; outline-offset: 2px; }
    details { margin-top: 28px; color: #adadb8; font-size: 13px; overflow-wrap: anywhere; }
    summary { cursor: pointer; width: fit-content; }
    code { display: block; margin-top: 12px; white-space: pre-wrap; }
  </style>
</head>
<body>
  <main>
    <svg class="icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
      <circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 4h.01"/>
    </svg>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${failedUrl.startsWith('data:') ? '' : `<p class="url">${escapeHtml(failedUrl)}</p>`}
    <div class="actions">
      <button class="primary" id="awrit-retry">Retry</button>
      <button id="awrit-back">Go Back</button>
      ${canOpenExternal ? '<button id="awrit-external">Open in Browser</button>' : ''}
    </div>
    <details><summary>Details</summary><code>${escapeHtml(diagnostics)}</code></details>
  </main>
  <script>
    (function () {
      var url = ${scriptString(failedUrl)};
      function goBack() {
        if (window.awrit && window.awrit.goBack) window.awrit.goBack();
      }
      var back = document.getElementById('awrit-back');
      var ext = document.getElementById('awrit-external');
      var retryButton = document.getElementById('awrit-retry');
      back.onclick = goBack;
      if (ext) ext.onclick = function () {
        if (window.awrit && window.awrit.openExternal) window.awrit.openExternal(url);
      };
      retryButton.onclick = function () {
        if (window.awrit && window.awrit.retry) window.awrit.retry();
        else location.href = url;
      };
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') { e.preventDefault(); goBack(); }
      });
      retryButton.focus();
    })();
  </script>
</body>
</html>`;
}
