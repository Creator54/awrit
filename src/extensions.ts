import { installExtension } from 'electron-chrome-web-store';
import { sessionPromise } from './session';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import path from 'node:path';

const CHROME_WEB_STORE_EXTENSIONS: string[] = [
  // uBlock Origin Lite
  // 'ddkjiahejlhfcafbddmgiahcphecmpfh',
];

const hasExtensions = CHROME_WEB_STORE_EXTENSIONS.length > 0;

// Only initialize the extensions system if there are actually extensions to load.
// ElectronChromeExtensions spins up additional IPC handlers and intercepts web requests,
// so skipping it when unused saves memory and startup time.
export const extensionsPromise: Promise<ElectronChromeExtensions | null> = hasExtensions
  ? sessionPromise.then((session) => {
      return new ElectronChromeExtensions({
        session,
        license: 'GPL-3.0',
        modulePath: path.join(__dirname, '../node_modules/electron-chrome-extensions'),
      });
    })
  : Promise.resolve(null);

export const installedExtensionsPromise: Promise<PromiseSettledResult<any>[]> = hasExtensions
  ? sessionPromise.then((session) =>
      Promise.allSettled(
        CHROME_WEB_STORE_EXTENSIONS.map((id) => installExtension(id, { session })),
      ),
    )
  : Promise.resolve([]);
