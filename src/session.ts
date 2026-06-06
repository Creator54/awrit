import { app, session as ElectronSession, type Session, ipcMain } from 'electron';
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
const pendingPermissions = new Map<number, (allow: boolean) => void>();
let nextPermId = 1;

export const sitePermissions = new Map<string, Record<string, boolean>>();

function notifyPermissionsChanged(origin: string) {
  const { managedViews } = require('./windows');
  for (const view of managedViews) {
    try {
      if (new URL(view.content.webContents.getURL()).origin === origin) {
        view.toolbar.webContents.send('awrit:site-permissions-changed', sitePermissions.get(origin) || {});
      }
    } catch {}
  }
}

ipcMain.handle('awrit:get-site-permissions', (_event, url: string) => {
  try {
    const origin = new URL(url).origin;
    return sitePermissions.get(origin) || {};
  } catch {
    return {};
  }
});

ipcMain.on('awrit:revoke-site-permission', (_event, url: string, permission: string) => {
  try {
    const origin = new URL(url).origin;
    const perms = sitePermissions.get(origin);
    if (perms) {
      delete perms[permission];
      notifyPermissionsChanged(origin);
      // Reload any webContents at this origin to reset Electron's internal permission cache
      const { managedViews } = require('./windows');
      for (const view of managedViews) {
        try {
          if (new URL(view.content.webContents.getURL()).origin === origin) {
            view.content.webContents.reload();
          }
        } catch {}
      }
    }
  } catch {}
});

ipcMain.on('toolbar:permission-response', (event, { id, allowed, url, permission, mediaTypes }) => {
  const cb = pendingPermissions.get(id);
  if (cb) {
    cb(allowed);
    pendingPermissions.delete(id);
    
    // Save to persistent map
    try {
      const origin = new URL(url).origin;
      if (!sitePermissions.has(origin)) sitePermissions.set(origin, {});
      if (allowed && permission === 'media' && mediaTypes) {
        sitePermissions.get(origin)![permission] = mediaTypes.join(',');
      } else {
        sitePermissions.get(origin)![permission] = allowed;
      }
      notifyPermissionsChanged(origin);
    } catch {}
  }
  const { managedViews } = require('./windows');
  const view = managedViews.find((v: any) => v.toolbar.webContents === event.sender);
  if (view) {
    view.toolbar.setIgnoreMouseEvents(!view.omniboxVisible && !view.keyHelpVisible && !view.findVisible);
    if (view.omniboxVisible || view.findVisible || view.keyHelpVisible) {
      view.toolbar.focusOnWebView();
    } else {
      view.content.focusOnWebView();
    }
  }
});

export const sessionPromise = new Promise<Session>((resolve) => {
  app.whenReady().then(() => {
    let session: Session;

    if (sessionConfig.profile) {
      const profilePath = path.resolve(sessionConfig.profile);
      const pathHash = Math.abs(profilePath.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 100000);
      const partitionName = `persist:awrit-profile-${pathHash}`;
      session = ElectronSession.fromPartition(partitionName);
    } else {
      session = ElectronSession.fromPartition('persist:awrit');
    }

    // Clean up the User Agent to be honest but professional
    const rawUserAgent = session.getUserAgent();
    const cleanUA = rawUserAgent
      .replace(/\sawrit\/\S+/, '') // Remove internal metadata
      .trim();

    session.setUserAgent(cleanUA);

    // Disable spellchecker to save memory (Hunspell dictionaries ~10MB)
    session.setSpellCheckerEnabled(false);

    // Auto-allow media permissions for offscreen rendering
    session.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
      const autoAllow = ['fullscreen', 'clipboard-read', 'clipboard-sanitized-write'];
      if (autoAllow.includes(permission)) {
        return true;
      }
      
      try {
        const origin = new URL(requestingOrigin).origin;
        const perms = sitePermissions.get(origin);
        if (perms && perms[permission] !== undefined) {
          // If the permission is blocked (false), return false.
          // If it is granted (true or string like 'audio,video'), return true.
          return !!perms[permission];
        }
      } catch {}
      
      return false;
    });

    session.setPermissionRequestHandler((webContents, permission, callback, details) => {
      const autoAllow = ['mediaDevice', 'fullscreen', 'clipboard-read', 'clipboard-sanitized-write'];
      const promptPermissions = ['media', 'notifications', 'geolocation'];

      if (autoAllow.includes(permission)) {
        return callback(true);
      }

      if (promptPermissions.includes(permission)) {
        try {
          const origin = new URL(details.requestingUrl).origin;
          const perms = sitePermissions.get(origin);
          if (perms && perms[permission] !== undefined) {
            return callback(perms[permission]);
          }
        } catch {}

        const id = nextPermId++;
        pendingPermissions.set(id, callback);
        const { managedViews } = require('./windows');
        const view = managedViews.find((v: any) => v.content.webContents === webContents);
        if (view) {
          view.toolbar.webContents.send('toolbar:permission-request', {
            id,
            permission,
            url: details.requestingUrl,
            mediaTypes: (details as any).mediaTypes
          });
          view.toolbar.setIgnoreMouseEvents(false);
          view.toolbar.focusOnWebView(); // <-- Crucial: route terminal events to toolbar
        } else {
          pendingPermissions.delete(id);
          callback(false);
        }
      } else {
        callback(false);
      }
    });

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

