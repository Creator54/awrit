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
    
    // pretend we're Chrome
    const userAgent = session
      .getUserAgent()
      .replace(/\sElectron\/\S+/, '')
      .replace(new RegExp(`\\s${app.getName()}/\\S+`), '');

    session.setUserAgent(userAgent);
    resolve(session);
  });
});
