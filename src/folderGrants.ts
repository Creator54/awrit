import path from 'node:path';

interface Grant {
  origin: string;
  folder: string;
}

/** Folders the user handed to each page, readable only. */
const grantsByPage = new Map<number, Grant[]>();

const isInside = (folder: string, file: string) => file === folder || file.startsWith(`${folder}${path.sep}`);

const originOf = (url: string): string | null => {
  try {
    const { origin } = new URL(url);
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
};

/** Records that the user gave the page at `pageUrl` read access to `folder`. */
export function grantFolder(pageId: number, pageUrl: string, folder: string): void {
  const origin = originOf(pageUrl);
  if (!origin) return;
  const grants = grantsByPage.get(pageId) ?? [];
  grants.push({ origin, folder: path.resolve(folder) });
  grantsByPage.set(pageId, grants);
}

/** Forgets one page's folders, on navigation or when the pane closes. */
export function clearGrants(pageId: number): void {
  grantsByPage.delete(pageId);
}

/**
 * Whether `requestingOrigin` may use `details.filePath`. Only reads inside a folder the
 * user chose for a page on that origin are allowed; never a write.
 *
 * Electron runs this check without the page's webContents, so grants are matched by origin.
 */
export function permitsFileSystem(
  requestingOrigin: string,
  details: { fileAccessType?: string; filePath?: string },
): boolean {
  if (details.fileAccessType !== 'readable' || typeof details.filePath !== 'string') return false;
  const origin = originOf(requestingOrigin);
  if (!origin) return false;
  const file = path.resolve(details.filePath);
  for (const grants of grantsByPage.values()) {
    for (const grant of grants) {
      if (grant.origin === origin && isInside(grant.folder, file)) return true;
    }
  }
  return false;
}
