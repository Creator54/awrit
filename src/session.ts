import { app, session as ElectronSession, type Session } from 'electron';
import * as path from 'node:path';
import * as os from 'node:os';

let sessionConfig = {
  profile: null as string | null,
};

export function loadSessionConfig(config: { profile?: string | null }) {
  if (config.profile) {
    sessionConfig.profile = config.profile;
  }
}

export const sessionPromise = new Promise<Session>((resolve) => {
  app.whenReady().then(() => {
    let session: Session;
    
    if (sessionConfig.profile) {
      // Use custom profile path - create unique partition name from path hash
      const profilePath = path.resolve(sessionConfig.profile);
      const pathHash = Math.abs(profilePath.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 100000);
      const partitionName = `persist:awrit-profile-${pathHash}`;
      session = ElectronSession.fromPartition(partitionName);
    } else {
      // Use default partition
      session = ElectronSession.fromPartition('persist:custom-awrit');
    }
    
    // Pretend we're Safari (not Chrome to avoid detection)
    const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15`;

    session.setUserAgent(userAgent);
    resolve(session);
  });
});
