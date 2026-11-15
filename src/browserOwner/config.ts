import fs from 'node:fs';
import path from 'node:path';

type Config = typeof import('../../config.js');

/** Watch the directory so atomic editor saves do not orphan the file watcher. */
export function watchOwnerConfig(
  file: string,
  apply: (config: Config) => void,
  onError: (error: unknown) => void,
): () => void {
  const resolved = require.resolve(file);
  const read = (): Config => {
    const previous = require.cache[resolved];
    delete require.cache[resolved];
    try {
      return require(resolved);
    } catch (error) {
      if (previous) require.cache[resolved] = previous;
      throw error;
    }
  };
  apply(read());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        apply(read());
      } catch (error) {
        onError(error);
      }
    }, 100);
  };
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(path.dirname(resolved), (_event, name) => {
      if (name === null || name.toString() === path.basename(resolved)) changed();
    });
    watcher.on('error', onError);
  } catch (error) {
    onError(error);
    fs.watchFile(resolved, { interval: 1000 }, changed);
  }
  return () => {
    watcher?.close();
    if (!watcher) fs.unwatchFile(resolved, changed);
    clearTimeout(timer);
  };
}
