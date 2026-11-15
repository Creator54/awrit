import type { PendingFileChooser } from './owner';

/** Keep Chromium's chooser occupied until verified installation or cancellation. */
export function requestRemoteFile(
  request: (chooser: PendingFileChooser) => void,
  signal: AbortSignal,
  install: (file: string) => Promise<void>,
): Promise<Electron.OpenDialogReturnValue> {
  return new Promise((resolve) => {
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      resolve({ canceled: true, filePaths: [] });
    };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) {
      cancel();
      return;
    }
    try {
      request({
        signal,
        cancel,
        install: async (file) => {
          if (settled || signal.aborted) throw new Error('File chooser canceled');
          await install(file);
          if (settled || signal.aborted) throw new Error('File chooser canceled');
          // Installation already happened; do not ask setupFileChooser to repeat it.
          cancel();
        },
      });
    } catch {
      cancel();
    }
  });
}
