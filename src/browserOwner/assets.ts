import path from 'node:path';

export function ownerAssets(entry: string) {
  const directory = path.resolve(path.dirname(entry), '..');
  return { directory, config: path.resolve(directory, '../config.js') };
}
