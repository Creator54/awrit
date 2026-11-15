import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pickArgs } from './picker';

test('picker routes selections and cancellation without executing actions', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-picker-'));
  const keys = [
    'PATH',
    'AWRIT_ANDROID_REGISTRY_PATH',
    'AWRIT_TEST_CHOICE',
    'AWRIT_TEST_INPUT',
    'AWRIT_TEST_IMAGE',
    'AWRIT_TEST_DEVICE',
    'AWRIT_TEST_ACTION',
  ] as const;
  const saved = keys.map((key) => process.env[key]);
  writeFileSync(
    path.join(dir, 'fzf'),
    `#!/bin/sh
if [ "$AWRIT_TEST_CHOICE" = cancel ]; then exit 130; fi
for arg in "$@"; do
  case "$arg" in
    --prompt=Awrit*) printf '%s\\n' "$AWRIT_TEST_CHOICE"; exit 0;;
    --prompt=URL*)
      case "$AWRIT_TEST_INPUT" in
        filtered) printf 'exam\\nhttps://example.com\\n'; exit 0;;
        empty) printf '\\n'; exit 1;;
        cancel) exit 130;;
      esac
      printf 'https://example.org/a?x=1&y=2\\n\\n'; exit 1;;
    --prompt=New*) printf 'testvm\\n\\n'; exit 1;;
    --prompt=Image*)
      if [ "$AWRIT_TEST_IMAGE" = cancel ]; then exit 130; fi
      printf '%s\\n' "$AWRIT_TEST_IMAGE"; exit 0;;
    --prompt=Android\\ devices*) printf '%s\\n' "$AWRIT_TEST_DEVICE"; exit 0;;
    --prompt=Action*) printf '%s\\n' "$AWRIT_TEST_ACTION"; exit 0;;
    --prompt=Android*)
      if [ "$AWRIT_TEST_INPUT" = custom ]; then printf '14.0\\n\\n'; exit 1; fi
      printf 'pin\\nDefault: pinned Android 13\\n'; exit 0;;
  esac
done
exit 2
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(dir, 'devices.json'),
    JSON.stringify({ version: 1, devices: { phone: { name: 'phone' } } }),
  );
  process.env.PATH = `${dir}:${saved[0]}`;
  process.env.AWRIT_ANDROID_REGISTRY_PATH = path.join(dir, 'devices.json');
  try {
    process.env.AWRIT_TEST_CHOICE = 'Android';
    process.env.AWRIT_TEST_DEVICE = 'Doctor: check setup';
    expect(await pickArgs()).toEqual(['device', 'doctor']);
    process.env.AWRIT_TEST_CHOICE = 'Browser: open URL';
    expect(await pickArgs()).toEqual(['--url', 'https://example.org/a?x=1&y=2']);
    process.env.AWRIT_TEST_INPUT = 'filtered';
    expect(await pickArgs()).toEqual(['--url', 'https://example.com']);
    process.env.AWRIT_TEST_INPUT = 'empty';
    expect(await pickArgs()).toBeNull();
    process.env.AWRIT_TEST_INPUT = 'cancel';
    expect(await pickArgs()).toBeNull();
    process.env.AWRIT_TEST_CHOICE = 'Android';
    process.env.AWRIT_TEST_DEVICE = 'New device';
    process.env.AWRIT_TEST_IMAGE = 'Google APIs (default: 13)';
    delete process.env.AWRIT_TEST_INPUT;
    expect(await pickArgs()).toEqual(['device', 'create', 'testvm']);
    process.env.AWRIT_TEST_INPUT = 'custom';
    expect(await pickArgs()).toEqual(['device', 'create', 'testvm', '--api=14.0']);
    process.env.AWRIT_TEST_IMAGE = 'AOSP 13 (local build)';
    expect(await pickArgs()).toEqual([
      'device',
      'create',
      'testvm',
      '--image=localhost/awrit-android-aosp:latest',
    ]);
    process.env.AWRIT_TEST_IMAGE = 'cancel';
    expect(await pickArgs()).toBeNull();
    process.env.AWRIT_TEST_DEVICE = 'phone';
    process.env.AWRIT_TEST_ACTION = 'start';
    expect(await pickArgs()).toEqual(['device', 'start', 'phone']);
    process.env.AWRIT_TEST_CHOICE = 'cancel';
    expect(await pickArgs()).toBeNull();
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
    rmSync(dir, { recursive: true, force: true });
  }
});
