import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

export function ownerBuildIdentity(entry: string): string {
  return createHash('sha256').update(readFileSync(entry)).digest('hex');
}
