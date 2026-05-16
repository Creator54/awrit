import { app, session as ElectronSession, type Session } from 'electron';
import * as path from 'node:path';

let sessionConfig = {
  profile: null as string | null,
};

export function loadSessionConfig(config: { profile?: string | null }) {
  if (config.profile) {
    sessionConfig.profile = config.profile;
  }
}

let useFirefoxSpoof = true;
export function setUseFirefoxSpoof(value: boolean) {
  useFirefoxSpoof = value;
}

// ===========================================
// User-Agent Constants
// ===========================================

// Firefox UA — Google skips embedded browser detection for Firefox
const FIREFOX_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:138.0) Gecko/20100101 Firefox/138.0';

// Chrome UA — extracted from Electron's raw UA, with Electron stripped
let chromeUA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
let chromeVersion = '138.0.0.0';
let chromeMajor = '138';

/**
 * Check if a URL belongs to a Google domain.
 * @deprecated Google recommends using system browser OAuth instead of embedded spoofing.
 * See: docs/oauth_migration_plan.md
 */
export function isGoogleDomain(url: string): boolean {
  if (!useFirefoxSpoof) return false;
  try {
    const hostname = new URL(url).hostname;
    return (
      hostname === 'google.com' ||
      hostname.endsWith('.google.com') ||
      hostname === 'youtube.com' ||
      hostname.endsWith('.youtube.com') ||
      hostname === 'googleapis.com' ||
      hostname.endsWith('.googleapis.com') ||
      hostname === 'gstatic.com' ||
      hostname.endsWith('.gstatic.com') ||
      hostname === 'ggpht.com' ||
      hostname === 'googleusercontent.com' ||
      hostname.endsWith('.googleusercontent.com')
    );
  } catch {
    return false;
  }
}

/**
 * Get the appropriate User-Agent for a given URL.
 * Google domains get Firefox UA; everything else gets Chrome UA.
 */
export function getUAForURL(url: string): string {
  return isGoogleDomain(url) ? FIREFOX_UA : chromeUA;
}

export const sessionPromise = new Promise<Session>((resolve) => {
  app.whenReady().then(() => {
    let session: Session;

    if (sessionConfig.profile) {
      const profilePath = path.resolve(sessionConfig.profile);
      const pathHash = Math.abs(profilePath.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 100000);
      const partitionName = `persist:awrit-profile-${pathHash}`;
      session = ElectronSession.fromPartition(partitionName);
    } else {
      session = ElectronSession.fromPartition('persist:custom-awrit');
    }

    // Extract the real Chrome version from Electron's raw UA
    const rawUserAgent = session.getUserAgent();
    const chromeVersionMatch = rawUserAgent.match(/Chrome\/([0-9.]+)/);
    if (chromeVersionMatch) {
      chromeVersion = chromeVersionMatch[1];
      chromeMajor = chromeVersion.split('.')[0];
    }

    // Build Chrome UA by stripping Electron references
    chromeUA = rawUserAgent
      .replace(/\sElectron\/\S+/, '')
      .replace(/\sawrit\/\S+/, '')
      .trim();

    // Set session default to Chrome UA (Electron stripped)
    session.setUserAgent(chromeUA);

    // TODO: Transition to system browser OAuth2 for Google logins.
    // The following webRequest interceptor spoofs Firefox to bypass embedded detection.
    // Intercept outgoing requests — per-domain UA spoofing
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders;
      const url = details.url;
      const isGoogle = isGoogleDomain(url);
      const h = new URL(url).hostname;
      const isGoogleBase = h === 'google.com' || h.endsWith('.google.com') ||
                           h === 'youtube.com' || h.endsWith('.youtube.com');

      if (isGoogle) {
        // ===== FIREFOX SPOOF MODE =====
        headers['User-Agent'] = FIREFOX_UA;
        delete headers['sec-ch-ua'];
        delete headers['sec-ch-ua-mobile'];
        delete headers['sec-ch-ua-platform'];
        delete headers['sec-ch-ua-arch'];
        delete headers['sec-ch-ua-bitness'];
        delete headers['sec-ch-ua-full-version'];
        delete headers['sec-ch-ua-full-version-list'];
        delete headers['sec-ch-ua-model'];
        delete headers['sec-ch-ua-platform-version'];
        delete headers['sec-ch-ua-wow64'];
      } else if (isGoogleBase) {
        // ===== CHROME SPOOF MODE (No Firefox spoof, but still need to hide Electron) =====
        // Strip Electron/awrit from UA
        const rawUA = headers['User-Agent'] || '';
        headers['User-Agent'] = rawUA.replace(/Electron\/[0-9.]+\s/g, '').replace(/awrit\/[0-9.]+\s/g, '');
        
        // Strip Electron from Client Hints
        if (headers['sec-ch-ua']) {
          headers['sec-ch-ua'] = headers['sec-ch-ua'].replace(/"Electron";v="[0-9.]+",\s?/g, '');
        }
        if (headers['sec-ch-ua-full-version-list']) {
          headers['sec-ch-ua-full-version-list'] = headers['sec-ch-ua-full-version-list'].replace(/"Electron";v="[0-9.]+",\s?/g, '');
        }
      } else {
        // Chrome mode: send correct sec-ch-ua with real Chrome version
        headers['User-Agent'] = chromeUA;
        headers['sec-ch-ua'] = `"Google Chrome";v="${chromeMajor}", "Chromium";v="${chromeMajor}", "Not/A)Brand";v="8"`;
        headers['sec-ch-ua-mobile'] = '?0';
        headers['sec-ch-ua-platform'] = '"Linux"';
        headers['sec-ch-ua-platform-version'] = '"6.8.0"';
        headers['sec-ch-ua-full-version-list'] = `"Google Chrome";v="${chromeVersion}", "Chromium";v="${chromeVersion}", "Not/A)Brand";v="8.0.0.0"`;
      }

      // Remove any Electron-specific headers
      delete headers['X-Electron'];
      
      // Force dark mode client hint
      headers['Sec-CH-Prefers-Color-Scheme'] = 'dark';

      callback({ requestHeaders: headers });
    });

    session.webRequest.onHeadersReceived((details, callback) => {
      callback({ responseHeaders: details.responseHeaders });
    });

    resolve(session);
  });
});
