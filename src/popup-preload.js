/**
 * awrit Popup Preload (contextIsolation: false, sandbox: false)
 *
 * This preload script is injected into native popup windows (like Google Auth).
 * Since we now use native Chromium popups (action: 'allow' + offscreen: false),
 * we no longer need to spoof window.opener. Chromium handles cross-window
 * MessageEvents securely and natively.
 *
 * The ONLY thing we need to do is prevent Google's bot detection from
 * flagging Electron as a webdriver.
 */

try {
  // Prevent Google bot detection flagging Electron as webdriver-controlled.
  Object.defineProperty(navigator, 'webdriver', {
    configurable: true,
    get: () => false,
  });
  console.log('[Awrit Preload] Anti-detection script successfully injected');
} catch (e) {
  // Silent — don't crash the popup on preload errors.
}
