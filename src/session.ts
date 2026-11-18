import { app, session as ElectronSession, type Session, type WebContents, ipcMain } from 'electron';
import { legacyPartitionExists, profilePartition } from './browserOwner/profile';
import { downloadsFolder, handleDownloads } from './downloads';
import { permitsFileSystem } from './folderGrants';

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
const pendingPermissions = new Map<
  number,
  { callback: (allow: boolean) => void; session: Session; sender: number }
>();
let nextPermId = 1;

const permissionsBySession = new WeakMap<Session, Map<string, Record<string, boolean>>>();
function permissions(session: Session) {
  let values = permissionsBySession.get(session);
  if (!values) {
    values = new Map();
    permissionsBySession.set(session, values);
  }
  return values;
}
// Last certificate Chromium verified per host, for the site-info panel. Chromium may
// reuse a cached verification, so a host can be missing; the panel then omits details.
const certificatesBySession = new WeakMap<
  Session,
  Map<string, { issuer: string; expires: number }>
>();

function senderSession(sender: WebContents): Session {
  const { managedViews } = require('./windows');
  const view = managedViews.find((v: any) => v.toolbar.webContents === sender);
  if (!view) throw new Error('Unknown permission renderer');
  return view.content.webContents.session;
}

function notifyPermissionsChanged(origin: string, session: Session) {
  const sitePermissions = permissions(session);
  const { managedViews } = require('./windows');
  for (const view of managedViews) {
    try {
      if (
        view.content.webContents.session === session &&
        new URL(view.content.webContents.getURL()).origin === origin
      ) {
        view.toolbar.webContents.send(
          'awrit:site-permissions-changed',
          sitePermissions.get(origin) || {},
        );
      }
    } catch {}
  }
}

ipcMain.handle('awrit:get-site-permissions', (event, url: string) => {
  try {
    const sitePermissions = permissions(senderSession(event.sender));
    const origin = new URL(url).origin;
    return sitePermissions.get(origin) || {};
  } catch {
    return {};
  }
});

ipcMain.handle('awrit:get-site-info', async (event, url: string) => {
  try {
    const session = senderSession(event.sender);
    const { protocol, hostname } = new URL(url);
    if (protocol !== 'http:' && protocol !== 'https:') return null;
    const cookies = (await session.cookies.get({ url })).length;
    return { cookies, certificate: certificatesBySession.get(session)?.get(hostname) ?? null };
  } catch {
    return null;
  }
});

ipcMain.handle('awrit:clear-site-cookies', async (event, url: string) => {
  try {
    const session = senderSession(event.sender);
    for (const cookie of await session.cookies.get({ url })) {
      await session.cookies.remove(url, cookie.name);
    }
    return (await session.cookies.get({ url })).length;
  } catch {
    throw new Error('Could not clear cookies');
  }
});

ipcMain.on(
  'awrit:set-site-permission',
  (event, url: string, permission: string, choice: 'ask' | 'allow' | 'block') => {
    try {
      const session = senderSession(event.sender);
      const sitePermissions = permissions(session);
      const origin = new URL(url).origin;
      const perms = sitePermissions.get(origin) ?? {};
      const before =
        perms[permission] === undefined ? 'ask' : perms[permission] ? 'allow' : 'block';
      const changed = before !== choice;
      if (choice === 'ask') delete perms[permission];
      else perms[permission] = choice === 'allow';
      sitePermissions.set(origin, perms);
      notifyPermissionsChanged(origin, session);
      if (!changed) return;
      // Reload pages at this origin so Electron drops its cached decision.
      const { managedViews } = require('./windows');
      for (const view of managedViews) {
        try {
          if (
            view.content.webContents.session === session &&
            new URL(view.content.webContents.getURL()).origin === origin
          ) {
            view.content.webContents.reload();
          }
        } catch {}
      }
    } catch {}
  },
);

ipcMain.on('toolbar:permission-response', (event, { id, allowed, url, permission, mediaTypes }) => {
  const pending = pendingPermissions.get(id);
  if (pending && pending.sender === event.sender.id) {
    const session = pending.session;
    const sitePermissions = permissions(session);
    pending.callback(allowed);

    // Save to persistent map
    try {
      const origin = new URL(url).origin;
      if (!sitePermissions.has(origin)) sitePermissions.set(origin, {});
      if (allowed && permission === 'media' && mediaTypes) {
        // biome-ignore lint/style/noNonNullAssertion: origin is guaranteed present by the `has` check above
        sitePermissions.get(origin)![permission] = mediaTypes.join(',');
      } else {
        // biome-ignore lint/style/noNonNullAssertion: origin is guaranteed present by the `has` check above
        sitePermissions.get(origin)![permission] = allowed;
      }
      notifyPermissionsChanged(origin, session);
    } catch {}
  }
  const { managedViews } = require('./windows');
  const view = managedViews.find((v: any) => v.toolbar.webContents === event.sender);
  if (view) {
    const toolbarOwnsInput = view.omniboxVisible || view.keyHelpVisible || view.findVisible || view.designMode;
    view.toolbar.setIgnoreMouseEvents(!toolbarOwnsInput);
    if (toolbarOwnsInput) {
      view.toolbar.focusOnWebView();
    } else {
      view.content.focusOnWebView();
    }
  }
});

const sessions = new Map<string, Promise<Session>>();
export function getProfileSession(profile: string | null): Promise<Session> {
  const partition = profilePartition(profile, legacyPartitionExists(app.getPath('userData')));
  const existing = sessions.get(partition);
  if (existing) return existing;
  const promise = app.whenReady().then(() => {
    const session = ElectronSession.fromPartition(partition);
    const sitePermissions = permissions(session);
    // Clean up the User Agent to be honest but professional
    const rawUserAgent = session.getUserAgent();
    const cleanUA = rawUserAgent
      .replace(/\sawrit\/\S+/, '') // Remove internal metadata
      .trim();

    session.setUserAgent(cleanUA);

    // Disable spellchecker to save memory (Hunspell dictionaries ~10MB)
    session.setSpellCheckerEnabled(false);
    handleDownloads(session, downloadsFolder(app.getPath('downloads')));

    // Observe only: -3 keeps Chromium's own verdict.
    const certificates = new Map<string, { issuer: string; expires: number }>();
    certificatesBySession.set(session, certificates);
    session.setCertificateVerifyProc((request, callback) => {
      certificates.set(request.hostname, {
        issuer: request.certificate.issuerName,
        expires: request.certificate.validExpiry,
      });
      callback(-3);
    });

    // Auto-allow media permissions for offscreen rendering
    session.setPermissionCheckHandler((webContents, permission, requestingOrigin, details) => {
      const autoAllow = ['fullscreen', 'clipboard-sanitized-write'];
      if (autoAllow.includes(permission)) {
        return true;
      }
      if (permission === 'fileSystem') {
        return permitsFileSystem(requestingOrigin, details);
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
      const autoAllow = ['mediaDevice', 'fullscreen', 'clipboard-sanitized-write'];
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
        const { managedViews } = require('./windows');
        const view = managedViews.find((v: any) => v.content.webContents === webContents);
        if (view) {
          const toolbarContents: WebContents = view.toolbar.webContents;
          const finish = (allowed: boolean) => {
            if (!pendingPermissions.delete(id)) return;
            view.permissionPending = [...pendingPermissions.values()].some(
              (p) => p.sender === toolbarContents.id,
            );
            webContents.removeListener('destroyed', deny);
            toolbarContents.removeListener('destroyed', deny);
            callback(allowed);
          };
          const deny = () => {
            try {
              finish(false);
            } catch {
              /* The requesting renderer may already be gone. */
            }
          };
          // The toolbar shows one prompt at a time; answer an earlier one (without remembering it) so its page does not hang.
          for (const [, earlier] of [...pendingPermissions]) {
            if (earlier.sender === toolbarContents.id) earlier.callback(false);
          }
          pendingPermissions.set(id, { callback: finish, session, sender: toolbarContents.id });
          webContents.once('destroyed', deny);
          toolbarContents.once('destroyed', deny);
          view.permissionPending = true;
          view.toolbar.webContents.send('toolbar:permission-request', {
            id,
            permission,
            url: details.requestingUrl,
            mediaTypes: (details as any).mediaTypes,
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

    return session;
  });
  sessions.set(partition, promise);
  return promise;
}

export const sessionPromise = app.whenReady().then(() => getProfileSession(sessionConfig.profile));

export async function flushProfileSessions(): Promise<void> {
  for (const pending of sessions.values()) {
    const session = await pending;
    session.flushStorageData();
    await session.cookies.flushStore();
  }
}
