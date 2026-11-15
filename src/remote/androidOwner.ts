import type { FrameSink } from './frameSink';
import { createOwner, type OwnerDeps, type RemotePane, type RunningOwner } from './owner';
import { startSupervisor, type Supervisor, supervisorDir } from './supervisor';
import { ownerBuildIdentity } from '../browserOwner/build';

/**
 * The Android pane module. It is imported only when no pane factory is injected,
 * so this entry never touches Electron.
 */
async function defaultOpenPane(): Promise<OwnerDeps['openPane']> {
  const { createAndroidPane, androidDeviceFromUrl } = await import('./androidPane');
  return (url: string, _id: string, sink: FrameSink): RemotePane =>
    createAndroidPane(androidDeviceFromUrl(url), sink);
}

export interface AndroidOwnerDeps {
  /** Injected so tests drive the supervisor without adb or a pane. */
  openPane?: OwnerDeps['openPane'];
  /** Private supervisor directory override; tests pass a temp dir. */
  dir?: string;
}

/**
 * Runs the Android remote owner headless under Node: its own supervisor and
 * socket, separate from the Electron browser owner.
 */
export async function startAndroidOwner(deps: AndroidOwnerDeps = {}): Promise<RunningOwner> {
  let supervisor: Supervisor | undefined;
  const stop = (): Promise<void> => supervisor?.stop() ?? Promise.resolve();
  const owner = createOwner({
    android: true,
    openPane: deps.openPane ?? (await defaultOpenPane()),
    // With no session left there is nothing to serve, so stop the socket and
    // let Node exit instead of lingering like the Electron owner.
    onIdle: () => {
      stop().catch((error: unknown) => console.error('Android remote owner:', error));
    },
  });
  supervisor = await startSupervisor({
    dir: deps.dir ?? supervisorDir(ownerBuildIdentity(process.argv[1])),
    startOwner: async () => {},
    stopOwner: async () => {},
    onConnection: (socket) => owner.handleConnection(socket),
  });
  return { stop };
}

if (process.argv.includes('--remote-android-owner')) {
  startAndroidOwner().catch((error: unknown) => {
    console.error('Android remote owner:', error);
    process.exitCode = 1;
  });
}
