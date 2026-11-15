import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type LegacyPartitionExists = (partition: string) => boolean;

// Persisted compatibility: every existing user's logins live in this legacy name, so it must
// keep being returned until a caller passes `legacyExists` to opt into the hashed name.
export function legacyProfilePartition(profile: string): string {
  const absolute = path.resolve(profile);
  const hash = Math.abs(
    absolute.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0) % 100000,
  );
  return `persist:awrit-profile-${hash}`;
}

function hashedProfilePartition(profile: string): string {
  const digest = createHash('sha256').update(path.resolve(profile)).digest('hex');
  return `persist:awrit-profile-${digest.slice(0, 16)}`;
}

// Callers that pass `legacyExists` get the collision-safe sha256 name, unless the legacy
// partition already exists, in which case the legacy name is kept so no login is lost.
// Callers that do not pass it (the 1-arg form) still get the legacy name.
export function profilePartition(
  profile: string | null,
  legacyExists?: LegacyPartitionExists,
): string {
  if (!profile) return 'persist:awrit';
  const legacy = legacyProfilePartition(profile);
  if (!legacyExists) return legacy;
  return legacyExists(legacy) ? legacy : hashedProfilePartition(profile);
}

// Electron-free exists check so this module stays importable in plain bun tests.
export function legacyPartitionExists(userDataDir: string): LegacyPartitionExists {
  return (partition) => {
    const name = partition.startsWith('persist:') ? partition.slice('persist:'.length) : partition;
    return fs.existsSync(path.join(userDataDir, 'Partitions', name));
  };
}
