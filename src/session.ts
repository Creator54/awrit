import { app, session as ElectronSession, type Session } from 'electron';
import * as path from 'node:path';

const sessionConfig = {
  profile: null as string | null,
};

export function loadSessionConfig(config: { profile?: string | null }) {
  if (config.profile) {
    sessionConfig.profile = config.profile;
  }
}

/**
 * awrit uses a clean, transparent session. 
 * Sites can detect awrit via window.awrit and use the Secure Auth Bridge 
 * to handle authentication in the system browser.
 */

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

    // Clean up the User Agent to be honest but professional
    const rawUserAgent = session.getUserAgent();
    const cleanUA = rawUserAgent
      .replace(/\sawrit\/\S+/, '') // Remove internal metadata
      .trim();

    session.setUserAgent(cleanUA);

    // Disable spellchecker to save memory (Hunspell dictionaries ~10MB)
    session.setSpellCheckerEnabled(false);

    // standard header handling
    session.webRequest.onBeforeSendHeaders((details, callback) => {
      const headers = details.requestHeaders;
      
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

