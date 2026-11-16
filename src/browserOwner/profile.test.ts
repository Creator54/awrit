import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { legacyPartitionExists, legacyProfilePartition, profilePartition } from './profile';

function shaPartition(profile: string): string {
  const digest = createHash('sha256').update(path.resolve(profile)).digest('hex');
  return `persist:awrit-profile-${digest.slice(0, 16)}`;
}

test('profile partitions preserve the existing storage naming exactly', () => {
  expect(profilePartition(null)).toBe('persist:awrit');
  const profile = path.resolve('/tmp', 'awrit-profile-test');
  expect(profilePartition(profile)).toBe(legacyProfilePartition(profile));
  expect(profilePartition(profile + '/.')).toBe(profilePartition(profile));
  expect(profilePartition('/tmp/another-profile')).not.toBe(profilePartition(profile));
});

test('the 1-arg form still returns the legacy name', () => {
  const profile = '/tmp/awrit-one-arg-profile';
  expect(profilePartition(profile)).toBe(legacyProfilePartition(profile));
});

test('null stays the default partition even with an exists check', () => {
  expect(profilePartition(null, () => false)).toBe('persist:awrit');
});

test('an existing legacy partition keeps the legacy name', () => {
  const profile = '/tmp/awrit-legacy-exists';
  const legacy = legacyProfilePartition(profile);
  expect(profilePartition(profile, (partition) => partition === legacy)).toBe(legacy);
});

test('a missing legacy partition moves to the sha256 name', () => {
  const profile = '/tmp/awrit-new-partition';
  expect(profilePartition(profile, () => false)).toBe(shaPartition(profile));
});

test('paths with equal char-code sums get different new names', () => {
  const first = profilePartition('/tmp/ab', () => false);
  const second = profilePartition('/tmp/ba', () => false);
  expect(legacyProfilePartition('/tmp/ab')).toBe(legacyProfilePartition('/tmp/ba'));
  expect(first).not.toBe(second);
});

test('legacyPartitionExists checks the Partitions folder under the user data dir', () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-legacy-'));
  const name = 'awrit-profile-12345';
  const exists = legacyPartitionExists(userDataDir);
  try {
    expect(exists(`persist:${name}`)).toBe(false);
    fs.mkdirSync(path.join(userDataDir, 'Partitions', name), { recursive: true });
    expect(exists(`persist:${name}`)).toBe(true);
  } finally {
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
});
