import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import path from 'node:path';
import {
  captureDeviceLogcat,
  createDevice,
  DEFAULT_IMAGE,
  type DeviceProfile,
  type DoctorEnvironment,
  ensureContainerAuthFile,
  executeDeviceAction,
  getAdbSerialForDevice,
  deviceContainerName,
  getDeviceLockPath,
  getDeviceLogPath,
  installApkToDevice,
  LOCAL_AOSP_IMAGE,
  listConnectedAdbDevices,
  mergeManagedDevices,
  parseResolution,
  reverseDevicePort,
  startDevice,
  runDoctor,
  slowBootHint,
  updateRegistry,
  waitForAdb,
} from './androidManager';

describe('Android Manager', () => {
  let tempDir = '';
  const originalEnv = process.env.AWRIT_ANDROID_REGISTRY_PATH;

  beforeAll(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'awrit-reg-test-'));
    process.env.AWRIT_ANDROID_REGISTRY_PATH = path.join(tempDir, 'devices.json');
  });

  afterAll(() => {
    if (originalEnv) {
      process.env.AWRIT_ANDROID_REGISTRY_PATH = originalEnv;
    } else {
      delete process.env.AWRIT_ANDROID_REGISTRY_PATH;
    }
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch (_e) {}
  });

  test('slow boot hint qualifies saved status and ignores the current or stopped device', async () => {
    await updateRegistry((r) => {
      r.devices.hintA = { name: 'hintA', type: 'podman', status: 'running', createdAt: 0 };
      r.devices.hintB = { name: 'hintB', type: 'podman', status: 'stopped', createdAt: 0 };
    });
    try {
      expect(slowBootHint('hintB')).toContain("'hintA' is marked running (awrit device stop hintA)");
      expect(slowBootHint('hintA')).not.toContain('marked running');
    } finally {
      await updateRegistry((r) => {
        delete r.devices.hintA;
        delete r.devices.hintB;
      });
    }
  });

  test('doctor checks KVM, Podman, and memory limits', async () => {
    const doc = await runDoctor();
    expect(typeof doc.kvm).toBe('boolean');
    expect(typeof doc.podman).toBe('boolean');
    expect(typeof doc.freeMemMb).toBe('number');
  });

  const doctorEnvironment = (
    kvmExists: boolean,
    kvmReadWrite: boolean,
    hostArch: string,
  ): DoctorEnvironment => ({
    kvmExists: () => kvmExists,
    kvmReadWrite: () => kvmReadWrite,
    hostArch,
  });

  test('doctor reports KVM access separately from a missing device', async () => {
    const ready = await runDoctor(doctorEnvironment(true, true, 'x64'));
    expect(ready.kvmStatus).toBe('ready');
    expect(ready.kvm).toBe(true);

    const missing = await runDoctor(doctorEnvironment(false, false, 'x64'));
    expect(missing.kvmStatus).toBe('missing');
    expect(missing.kvm).toBe(false);

    const denied = await runDoctor(doctorEnvironment(true, false, 'x64'));
    expect(denied.kvmStatus).toBe('permission-denied');
    expect(denied.kvm).toBe(false);
  });

  test('doctor reports the host architecture against the x86_64 emulator image', async () => {
    const supported = await runDoctor(doctorEnvironment(true, true, 'x64'));
    expect(supported.hostArch).toBe('x86_64');
    expect(supported.imageArch).toBe('x86_64');
    expect(supported.archSupported).toBe(true);

    const mismatch = await runDoctor(doctorEnvironment(true, true, 'arm64'));
    expect(mismatch.hostArch).toBe('arm64');
    expect(mismatch.archSupported).toBe(false);
  });

  test('doctor does not recommend a managed Linux runtime on macOS', async () => {
    const doc = await runDoctor({ ...doctorEnvironment(true, true, 'x64'), platform: 'darwin' });
    expect(doc.kvm).toBe(true);
    expect(doc.archSupported).toBe(true);
    expect(doc.runtimeSelection.status).toBe('unsupported');
    expect(doc.runtimeSelection.runtime).toBeNull();
    expect(doc.runtimeSelection.reason).toContain('darwin');
  });

  test('failed registry transactions release the lock and do not save changes', async () => {
    const registryPath = path.join(tempDir, 'devices.json');
    const before = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : null;
    await expect(updateRegistry((registry) => {
      registry.devices = {};
      throw new Error('transaction failed');
    })).rejects.toThrow('transaction failed');
    expect(existsSync(`${registryPath}.lock`)).toBe(false);
    expect(existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : null).toBe(before);
  });

  test('concurrent processes retain every created profile and unique port', async () => {
    const registryPath = path.join(tempDir, 'concurrent.json');
    const managerPath = path.join(import.meta.dir, 'androidManager.ts');
    const workers = Array.from({ length: 24 }, (_, index) => Bun.spawn([
      process.execPath, '-e',
      `import { createDevice } from ${JSON.stringify(managerPath)};
       const result = await createDevice('concurrent-${index}');
       if (!result.ok) throw new Error(result.message);`,
    ], { env: { ...process.env, AWRIT_ANDROID_REGISTRY_PATH: registryPath }, stdout: 'pipe', stderr: 'pipe' }));
    try {
      expect(await Promise.all(workers.map((worker) => worker.exited))).toEqual(Array(24).fill(0));
      const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
      const devices = Object.values(registry.devices) as DeviceProfile[];
      expect(devices).toHaveLength(24);
      expect(new Set(devices.map((device) => device.port)).size).toBe(24);
      expect(existsSync(`${registryPath}.lock`)).toBe(false);
    } finally {
      for (const worker of workers) worker.kill();
    }
  }, 15000);

  test('resolutions are validated once for every create path', async () => {
    expect(parseResolution('1080x1920@420')).toEqual({
      ok: true,
      resolution: { width: 1080, height: 1920, density: 420 },
    });
    expect(parseResolution('720x1280')).toEqual({
      ok: true,
      resolution: { width: 720, height: 1280 },
    });
    expect(parseResolution(undefined)).toEqual({ ok: true, resolution: undefined });

    const valid = await createDevice('resolution-ok', {
      port: 5595,
      resolution: { width: 1080, height: 1920, density: 420 },
    });
    expect(valid.ok).toBe(true);
    expect(valid.profile?.resolution).toEqual({ width: 1080, height: 1920, density: 420 });
    await executeDeviceAction('delete', 'resolution-ok', { force: true });

    const badStrings = ['', '1080', '1080x', 'x1920', '0x0', '319x1920', '1080x8193',
      '1080x1920@0', '1080x1920@71', '1080x1920@641', '1080x1920@abc', '1080x1920@420@1',
      '1080X1920', '1080x1920foo'];
    const badObjects: unknown[] = [
      { width: 1080.5, height: 1920 }, { width: 1080, height: 1920, density: 0 },
      { width: '1080', height: 1920 }, { width: 1080, height: 1920, density: 700 },
      { width: NaN, height: 1920 },
    ];
    for (const raw of [...badStrings, ...badObjects]) {
      const parsed = parseResolution(raw);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error).toContain('widthxheight[@dpi]');
      const created = await createDevice('bad-resolution', { resolution: raw as any });
      expect(created.ok).toBe(false);
      expect(created.message).toContain('widthxheight[@dpi]');
    }
  });

  test('a profile without a resolution still starts', async () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'awrit-start-'));
    const runLog = path.join(bin, 'runs.log');
    const previousPath = process.env.PATH;
    const created = await createDevice('no-resolution-start', { port: 5597, image: LOCAL_AOSP_IMAGE });
    expect(created.ok).toBe(true);
    expect(created.profile?.resolution).toBeUndefined();
    writeFileSync(
      path.join(bin, 'podman'),
      '#!/bin/sh\ncase "$1" in\n  container) exit 1;;\n  run) echo "$@" >> "$AWRIT_TEST_RUN_LOG"; exit 0;;\nesac\nexit 0\n',
      { mode: 0o755 },
    );
    writeFileSync(
      path.join(bin, 'adb'),
      '#!/bin/sh\nif [ "$1" = devices ]; then printf "127.0.0.1:5597\\tdevice\\n"; fi\nexit 0\n',
      { mode: 0o755 },
    );
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    process.env.AWRIT_TEST_RUN_LOG = runLog;
    try {
      // Force skips the host free-memory guard; this test fakes Podman and never boots an emulator.
      const started = await startDevice('no-resolution-start', { force: true });
      expect(started.ok).toBe(true);
      const runs = readFileSync(runLog, 'utf8');
      expect(runs.split(' ')).toContain('run');
      expect(runs).not.toContain('SCREEN_WIDTH');
    } finally {
      process.env.PATH = previousPath;
      delete process.env.AWRIT_TEST_RUN_LOG;
      await executeDeviceAction('delete', 'no-resolution-start', { force: true });
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('invalid explicit creation ports are rejected without registry changes', async () => {
    const registryPath = path.join(tempDir, 'devices.json');
    const before = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : null;
    for (const port of [0, 80, -1, 1023, 65536, 5556.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const result = await createDevice('invalid-port-test', { port });
      expect(result.ok).toBe(false);
      expect(result.message).toContain('integer between 1024 and 65535');
      expect(existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : null).toBe(before);
    }
  });

  test('registry lifecycle: create, list, and delete device profile with isolation', async () => {
    const createRes = await executeDeviceAction('create', 'test-phone-1', {
      port: 5590,
      api: '14',
      deviceModel: 'Pixel 4',
    });
    expect(createRes.ok).toBe(true);
    expect(createRes.message).toContain('test-phone-1');
    expect(createRes.message).toContain('emulator_14.0');
    expect(createRes.data.deviceModel).toBe('Pixel 4');

    // Duplicate create rejected
    const dupRes = await executeDeviceAction('create', 'test-phone-1', { port: 5591 });
    expect(dupRes.ok).toBe(false);
    expect(dupRes.message).toContain('already exists');

    // Conflicting port rejected
    const portConflictRes = await executeDeviceAction('create', 'test-phone-conflict', {
      port: 5590,
    });
    expect(portConflictRes.ok).toBe(false);
    expect(portConflictRes.message).toContain('already assigned');

    // Invalid device name rejected
    const invalidRes = await executeDeviceAction('create', 'invalid name!!');
    expect(invalidRes.ok).toBe(false);
    expect(invalidRes.message).toContain('Invalid device name');

    // Serial resolution
    expect(getAdbSerialForDevice('test-phone-1')).toBe('127.0.0.1:5590');
    expect(getAdbSerialForDevice('unknown-device')).toBe('unknown-device');

    const listRes = await executeDeviceAction('list');
    expect(listRes.ok).toBe(true);
    expect(listRes.message).toContain('test-phone-1');

    const jsonListRes = await executeDeviceAction('list', undefined, { json: true });
    expect(jsonListRes.ok).toBe(true);
    const parsed = JSON.parse(jsonListRes.message);
    expect(Array.isArray(parsed.managed)).toBe(true);
    const item = parsed.managed.find((m: any) => m.name === 'test-phone-1');
    expect(item).toBeDefined();
    expect(item.status).toBe('stopped');

    const showRes = await executeDeviceAction('show', 'test-phone-1');
    expect(showRes.ok).toBe(true);
    expect(showRes.message).toContain('name: test-phone-1');
    expect(showRes.message).toContain('serial: 127.0.0.1:5590');
    const showJson = await executeDeviceAction('show', 'test-phone-1', { json: true });
    expect(JSON.parse(showJson.message).name).toBe('test-phone-1');
    const showMissing = await executeDeviceAction('show', 'nope');
    expect(showMissing.ok).toBe(false);
    expect(showMissing.message).toContain('awrit device list');
    expect((await executeDeviceAction('show')).message).toContain('Usage');

    const jsonCreateRes = await executeDeviceAction('create', 'test-phone-json', {
      json: true,
      port: 65492,
    });
    expect(jsonCreateRes.ok).toBe(true);
    const parsedCreate = JSON.parse(jsonCreateRes.message);
    expect(parsedCreate.name).toBe('test-phone-json');

    const jsonDelRes = await executeDeviceAction('delete', 'test-phone-json', { json: true, force: true });
    expect(jsonDelRes.ok).toBe(true);
    const parsedDel = JSON.parse(jsonDelRes.message);
    expect(parsedDel.deleted).toBe('test-phone-json');

    const delRes = await executeDeviceAction('delete', 'test-phone-1', { force: true });
    expect(delRes.ok).toBe(true);
    expect(delRes.message).toContain('Deleted');

    // JSON error handling tests
    const jsonStopNoName = await executeDeviceAction('stop', undefined, { json: true });
    expect(jsonStopNoName.ok).toBe(false);
    expect(JSON.parse(jsonStopNoName.message).error).toContain('name is required');

    const jsonDelUnknown = await executeDeviceAction('delete', 'unknown', { json: true });
    expect(jsonDelUnknown.ok).toBe(false);
    expect(JSON.parse(jsonDelUnknown.message).error).toContain('not found');

    // Delete unknown returns error cleanly
    const delUnknown = await executeDeviceAction('delete', 'unknown');
    expect(delUnknown.ok).toBe(false);

    // Stop unknown returns error cleanly
    const stopUnknown = await executeDeviceAction('stop', 'unknown');
    expect(stopUnknown.ok).toBe(false);
    expect(stopUnknown.message).toContain('not found');

    // Missing name returns error cleanly
    const stopNoName = await executeDeviceAction('stop');
    expect(stopNoName.ok).toBe(false);
    expect(stopNoName.message).toContain('name is required');

    const delNoName = await executeDeviceAction('delete');
    expect(delNoName.ok).toBe(false);
    expect(delNoName.message).toContain('name is required');
  });

  test('delete needs confirmation for a running device or without a terminal', async () => {
    const registryPath = path.join(tempDir, 'devices.json');
    expect((await executeDeviceAction('create', 'delete-guard', { port: 65498 })).ok).toBe(true);
    const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
    registry.devices['delete-guard'].status = 'running';
    writeFileSync(registryPath, JSON.stringify(registry));

    const running = await executeDeviceAction('delete', 'delete-guard');
    expect(running.ok).toBe(false);
    expect(running.message).toContain('is running');
    expect(JSON.parse(readFileSync(registryPath, 'utf8')).devices['delete-guard']).toBeDefined();

    registry.devices['delete-guard'].status = 'stopped';
    writeFileSync(registryPath, JSON.stringify(registry));
    const nonInteractive = await executeDeviceAction('delete', 'delete-guard');
    expect(nonInteractive.ok).toBe(false);
    expect(nonInteractive.message).toContain('--force');
    expect(JSON.parse(readFileSync(registryPath, 'utf8')).devices['delete-guard']).toBeDefined();

    const forced = await executeDeviceAction('delete', 'delete-guard', { force: true });
    expect(forced.ok).toBe(true);
    expect(JSON.parse(readFileSync(registryPath, 'utf8')).devices['delete-guard']).toBeUndefined();
  });

  test('executeDeviceAction runs doctor output cleanly and supports json mode', async () => {
    // `ok` reports whether this machine can run Android, so it varies by environment.
    const doctorRes = await executeDeviceAction('doctor');
    expect(doctorRes.message).toContain('Android check:');
    expect(doctorRes.message).toContain('  Arch: ');

    const doctorJsonRes = await executeDeviceAction('doctor', undefined, { json: true });
    const parsed = JSON.parse(doctorJsonRes.message);
    expect(doctorJsonRes.ok).toBe(
      parsed.kvm && parsed.archSupported && parsed.podman && parsed.adb && parsed.ffmpeg,
    );
    expect(typeof parsed.kvm).toBe('boolean');
    expect(typeof parsed.kvmStatus).toBe('string');
    expect(typeof parsed.hostArch).toBe('string');
    expect(typeof parsed.imageArch).toBe('string');
    expect(typeof parsed.archSupported).toBe('boolean');
    expect(typeof parsed.podman).toBe('boolean');
    expect(typeof parsed.freeMemMb).toBe('number');
    if (parsed.freeDiskMb !== undefined) {
      expect(typeof parsed.freeDiskMb).toBe('number');
    }
  });

  test('ensureContainerAuthFile creates valid empty auth configuration', () => {
    const authPath = ensureContainerAuthFile();
    expect(typeof authPath).toBe('string');
    expect(authPath.endsWith('containers-auth.json')).toBe(true);
  });

  test('list reflects ADB availability without changing saved lifecycle state', async () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'awrit-list-'));
    const previousPath = process.env.PATH;
    const registryPath = path.join(tempDir, 'devices.json');
    const previousRegistry = readFileSync(registryPath, 'utf8');
    const devices: Record<string, DeviceProfile> = {
      stale: { name: 'stale', type: 'podman', status: 'running', serial: 'stale', createdAt: 0 },
      usb: { name: 'usb', type: 'physical', status: 'running', serial: 'usb', createdAt: 0 },
      stopped: { name: 'stopped', type: 'emulator', status: 'stopped', createdAt: 0 },
      online: { name: 'online', type: 'podman', status: 'stopped', serial: 'online', createdAt: 0 },
    };
    writeFileSync(path.join(bin, 'adb'), '#!/bin/sh\nprintf "online\\tdevice\\n"\n', {
      mode: 0o700,
    });
    const saved = JSON.stringify({ version: 1, devices });
    writeFileSync(registryPath, saved);
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    try {
      const res = await executeDeviceAction('list', undefined, { json: true });
      expect(res.ok).toBe(true);
      const listed: { managed: DeviceProfile[]; connected: string[] } = JSON.parse(res.message);
      expect(listed.connected).toEqual(['online']);
      expect(listed.managed.map((d) => d.status)).toEqual([
        'offline',
        'offline',
        'stopped',
        'running',
      ]);
      const text = await executeDeviceAction('list');
      expect(text.message).toContain('stale · offline');
      expect(text.message).toContain('online · online');
      expect(readFileSync(registryPath, 'utf8')).toBe(saved);
    } finally {
      process.env.PATH = previousPath;
      writeFileSync(registryPath, previousRegistry);
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('mergeManagedDevices reports running, stopped, missing and orphan containers', () => {
    const devices: DeviceProfile[] = [
      { name: 'a', type: 'podman', status: 'running', createdAt: 0 },
      { name: 'b', type: 'podman', status: 'stopped', createdAt: 0 },
      { name: 'c', type: 'podman', status: 'stopped', createdAt: 0 },
      { name: 'usb', type: 'physical', status: 'running', createdAt: 0 },
    ];
    const containers = [
      // 'b' predates labelling; it must still match its registry entry.
      { name: deviceContainerName('a'), id: '1', running: true, managed: true },
      { name: deviceContainerName('b'), id: '2', running: false, managed: false },
      { name: deviceContainerName('lost'), id: '3', running: false, managed: true },
      { name: 'unrelated', id: '4', running: true, managed: false },
    ];
    const { merged, orphans } = mergeManagedDevices(devices, containers);
    expect(merged.map((entry) => entry.containerState)).toEqual([
      'running',
      'stopped',
      'missing',
      undefined,
    ]);
    expect(orphans).toEqual([
      { name: deviceContainerName('lost'), containerId: '3', running: false, state: 'orphan' },
    ]);
    // Without Podman the container state stays unknown instead of claiming containers are gone.
    expect(mergeManagedDevices(devices, null).merged.every((e) => e.containerState === undefined)).toBe(
      true,
    );
  });

  test('list merges registry entries with Podman containers, labelled or not', async () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'awrit-merge-'));
    const previousPath = process.env.PATH;
    const registryPath = path.join(tempDir, 'devices.json');
    const previousRegistry = readFileSync(registryPath, 'utf8');
    writeFileSync(
      path.join(bin, 'podman'),
      `#!/bin/sh
if [ "$1" = --version ]; then printf 'podman test\\n';
elif [ "$1" = ps ]; then printf 'awrit-android-run|aaaaaaaaaaaa|running|1\\nawrit-android-stop|bbbbbbbbbbbb|exited|\\nawrit-android-orphan|cccccccccccc|exited|1\\nother|eeeeeeeeeeee|running|\\n';
fi
`,
      { mode: 0o700 },
    );
    writeFileSync(
      registryPath,
      JSON.stringify({
        version: 1,
        devices: {
          run: { name: 'run', type: 'podman', status: 'running', createdAt: 0 },
          stop: { name: 'stop', type: 'podman', status: 'stopped', createdAt: 0 },
          gone: { name: 'gone', type: 'podman', status: 'stopped', createdAt: 0 },
        },
      }),
    );
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    try {
      const res = await executeDeviceAction('list', undefined, { json: true });
      expect(res.ok).toBe(true);
      const listed = JSON.parse(res.message);
      expect(listed.managed.map((d: DeviceProfile & { container?: string }) => [d.name, d.container])).toEqual([
        ['run', 'running'],
        ['stop', 'stopped'],
        ['gone', 'missing'],
      ]);
      expect(listed.orphans).toEqual([
        {
          name: 'awrit-android-orphan',
          containerId: 'cccccccccccc',
          running: false,
          state: 'orphan',
        },
      ]);
      const text = await executeDeviceAction('list');
      expect(text.message).toContain('awrit-android-orphan · orphan · stopped');
    } finally {
      process.env.PATH = previousPath;
      writeFileSync(registryPath, previousRegistry);
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('prune lists orphans and leftover locks and only deletes with --yes', async () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'awrit-prune-'));
    const previousPath = process.env.PATH;
    const previousXdg = process.env.XDG_DATA_HOME;
    const registryPath = path.join(tempDir, 'devices.json');
    const calls = path.join(bin, 'calls');
    const previousRegistry = existsSync(registryPath) ? readFileSync(registryPath, 'utf8') : null;
    writeFileSync(
      path.join(bin, 'podman'),
      `#!/bin/sh
if [ "$1" = --version ]; then printf 'podman test\\n';
elif [ "$1" = ps ]; then printf 'awrit-android-prune-orphan|dddddddddddd|exited|1\\nawrit-android-unlabelled|ffffffffffff|exited|\\n';
elif [ "$1" = rm ]; then printf '%s\\n' "$*" >> '${calls}';
fi
`,
      { mode: 0o700 },
    );
    process.env.XDG_DATA_HOME = path.join(bin, 'data');
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    const lockName = 'prune-lock-test';
    const lockPath = getDeviceLockPath(lockName);
    let deadPid = 999999;
    while (deadPid > 100000) {
      try {
        process.kill(deadPid, 0);
        deadPid -= 1;
      } catch (e: unknown) {
        if ((e as { code?: string })?.code === 'ESRCH') break;
        deadPid -= 1;
      }
    }
    writeFileSync(lockPath, `${deadPid}:gone\n`);
    writeFileSync(registryPath, JSON.stringify({ version: 1, devices: {} }));
    try {
      const dry = await executeDeviceAction('prune', undefined, { json: true });
      expect(dry.ok).toBe(true);
      const dryRun = JSON.parse(dry.message);
      expect(dryRun.dryRun).toBe(true);
      expect(dryRun.orphans.map((o: { name: string }) => o.name)).toEqual([
        'awrit-android-prune-orphan',
      ]);
      expect(dryRun.locks.some((p: string) => p.endsWith(`${lockName}.lock`))).toBe(true);
      expect(existsSync(calls)).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
      expect((await executeDeviceAction('prune')).message).toContain('Dry run.');

      const confirmed = await executeDeviceAction('prune', undefined, { json: true, yes: true });
      expect(JSON.parse(confirmed.message).removed).toEqual({ containers: 1, locks: 1 });
      expect(readFileSync(calls, 'utf8')).toContain('rm -f awrit-android-prune-orphan');
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      process.env.PATH = previousPath;
      if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = previousXdg;
      if (previousRegistry === null) rmSync(registryPath, { force: true });
      else writeFileSync(registryPath, previousRegistry);
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('listConnectedAdbDevices handles invalid or missing adb binary gracefully', async () => {
    const devices = await listConnectedAdbDevices('/non/existent/adb/binary');
    expect(Array.isArray(devices)).toBe(true);
    expect(devices.length).toBe(0);
  });

  test('startDevice refuses start on unknown device name', async () => {
    const res = await executeDeviceAction('start', 'ghost-device-not-registered');
    expect(res.ok).toBe(false);
    expect(res.message).toContain('not found');
  });

  test('managed docker-android uses native headless mode while custom images keep their command', async () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'awrit-headless-'));
    const previousPath = process.env.PATH;
    const commands = path.join(bin, 'commands');
    writeFileSync(
      path.join(bin, 'podman'),
      `#!/bin/sh
if [ "$1" = --version ]; then printf 'podman test\\n';
elif [ "$1" = container ]; then exit 1;
elif [ "$1" = run ]; then printf '%s\\n' "$@" > '${commands}'; printf 'container-test\\n';
fi
`,
      { mode: 0o700 },
    );
    writeFileSync(
      path.join(bin, 'adb'),
      '#!/bin/sh\nif [ "$1" = devices ]; then printf "127.0.0.1:65491\\tdevice\\n"; fi\n',
      { mode: 0o700 },
    );
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    try {
      for (const image of [
        DEFAULT_IMAGE,
        'docker.io/budtmo/docker-android:emulator_14.0',
        LOCAL_AOSP_IMAGE,
        'local/custom-android',
      ]) {
        const managed = image !== 'local/custom-android';
        const name = image.includes('budtmo')
          ? image === DEFAULT_IMAGE
            ? 'headless-default'
            : 'headless-tag'
          : image === LOCAL_AOSP_IMAGE
            ? 'headless-aosp'
            : 'headless-custom';
        expect((await executeDeviceAction('create', name, { image, port: 65491 })).ok).toBe(true);
        expect((await executeDeviceAction('start', name, { force: true })).ok).toBe(true);
        const args = readFileSync(commands, 'utf8');
        expect(args.includes('EMULATOR_HEADLESS=true')).toBe(managed);
        expect(args.includes('EMULATOR_ADDITIONAL_ARGS=-no-window')).toBe(managed);
        expect(args.includes('Unsupported docker-android permission check')).toBe(managed);
        expect(args.includes('--user\nroot')).toBe(managed);
        expect(args.includes('setpriv --reuid=androidusr')).toBe(managed);
        expect(args).toContain(image);
        expect(args).not.toContain('--replace');
        await executeDeviceAction('delete', name, { force: true });
      }
    } finally {
      process.env.PATH = previousPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('start refuses an occupied ADB port and removes a container left by a failed run', async () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'awrit-transactional-'));
    const previousPath = process.env.PATH;
    const calls = path.join(bin, 'calls');
    const failRun = path.join(bin, 'fail-run');
    writeFileSync(
      path.join(bin, 'podman'),
      `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
case "$1" in
  --version) printf 'podman test\\n';;
  container) exit 1;;
  run) if [ -e '${failRun}' ]; then printf 'boom\\n' >&2; exit 125; fi; printf 'container-test\\n';;
esac
exit 0
`,
      { mode: 0o700 },
    );
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    const server = createServer();
    await new Promise<void>((resolve) => {
      server.listen({ port: 65496, host: '127.0.0.1' }, () => resolve());
    });
    try {
      expect((await executeDeviceAction('create', 'busy-port', { port: 65496 })).ok).toBe(true);
      const busy = await executeDeviceAction('start', 'busy-port', { force: true });
      expect(busy.ok).toBe(false);
      expect(busy.message).toContain('already in use');
      expect(readFileSync(calls, 'utf8')).not.toContain('run ');
      await executeDeviceAction('delete', 'busy-port', { force: true });

      writeFileSync(failRun, '1');
      expect((await executeDeviceAction('create', 'half-created', { port: 65497 })).ok).toBe(true);
      const failed = await executeDeviceAction('start', 'half-created', { force: true });
      expect(failed.ok).toBe(false);
      expect(failed.message).toContain('Failed to start container');
      expect(readFileSync(calls, 'utf8')).toContain('rm -f awrit-android-half-created');
      const registry = JSON.parse(readFileSync(path.join(tempDir, 'devices.json'), 'utf8'));
      expect(registry.devices['half-created'].status).toBe('stopped');
      expect(registry.devices['half-created'].containerId).toBeUndefined();
      await executeDeviceAction('delete', 'half-created', { force: true });
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      process.env.PATH = previousPath;
      rmSync(bin, { recursive: true, force: true });
    }
  });

  test('start reuses container state and refuses inspection errors without mutation', async () => {
    const bin = mkdtempSync(path.join(tmpdir(), 'awrit-resume-'));
    const previousPath = process.env.PATH;
    const commands = path.join(bin, 'commands');
    const state = path.join(bin, 'state');
    const rootfs = path.join(bin, 'rootfs');
    const avd = path.join(rootfs, 'home/androidusr/emulator');
    const outside = path.join(bin, 'outside');
    mkdirSync(outside);
    const containerId = 'a'.repeat(64);
    writeFileSync(
      path.join(bin, 'podman'),
      `#!/bin/sh
printf '%s\\n' "$*" >> '${commands}'
state=$(cat '${state}')
case "$1" in
  --version) printf 'podman test\\n';;
  container) case "$state" in absent|create-error) exit 1;; error) exit 125;; esac;;
  inspect) if [ "$4" = '{{.State.Running}}' ]; then printf 'false\\n'; else
    case "$state" in invalid) printf 'invalid\\n';; running|stop-error|shutdown-error|shutdown-timeout|stale-stop) printf '${containerId} true\\n';; *) printf '${containerId} false\\n';; esac; fi;;
  unshare) shift; exec "$@";;
  mount) if [ "$state" = cleanup-error ]; then exit 125; fi; printf '${rootfs}\\n';;
  unmount) exit 0;;
  exec) if [ "$state" = shutdown-error ]; then exit 125; fi
    if [ "$state" = shutdown-timeout ]; then exec sleep 60; fi;;
  stop) if [ "$state" = stop-error ]; then exit 125; fi;;
  run) if [ "$state" = create-error ]; then exit 125; fi; printf '${containerId}\\n';;
  start) printf '%s\\n' "$2";;
esac
`,
      { mode: 0o700 },
    );
    writeFileSync(
      path.join(bin, 'adb'),
      '#!/bin/sh\nif [ "$1" = devices ]; then printf "127.0.0.1:65493\\tdevice\\n"; fi\n',
      { mode: 0o700 },
    );
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    try {
      for (const scenario of [
        'absent',
        'stopped',
        'running',
        'error',
        'invalid',
        'create-error',
        'cleanup-error',
        'symlink',
      ]) {
        const name = `resume-${scenario}`;
        rmSync(rootfs, { recursive: true, force: true });
        mkdirSync(path.dirname(avd), { recursive: true });
        if (scenario === 'symlink') symlinkSync(outside, avd);
        else mkdirSync(avd);
        writeFileSync(path.join(avd, 'userdata-qemu.img'), 'preserved');
        const emulatorLocks = ['hardware-qemu.ini.lock', 'multiinstance.lock', 'snapshot.lock.lock'];
        for (const lock of emulatorLocks) writeFileSync(path.join(avd, lock), '69');
        writeFileSync(state, scenario);
        writeFileSync(commands, '');
        expect(
          (
            await executeDeviceAction('create', name, {
              port: 65493,
              image: scenario === 'stopped' ? LOCAL_AOSP_IMAGE : DEFAULT_IMAGE,
            })
          ).ok,
        ).toBe(true);
        const registryPath = path.join(tempDir, 'devices.json');
        if (scenario === 'create-error') {
          const stale = JSON.parse(readFileSync(registryPath, 'utf8'));
          stale.devices[name].status = 'running';
          stale.devices[name].containerId = 'stale-id';
          writeFileSync(registryPath, JSON.stringify(stale));
        }
        const result = await executeDeviceAction('start', name, { force: true });
        const calls = readFileSync(commands, 'utf8').split('\n');
        expect(result.ok).toBe(['absent', 'stopped', 'running'].includes(scenario));
        expect(calls.some((call) => call.startsWith('run '))).toBe(
          scenario === 'absent' || scenario === 'create-error',
        );
        expect(calls.includes(`start awrit-android-${name}`)).toBe(scenario === 'stopped');
        expect(calls.join('\n')).not.toContain('--replace');
        expect(existsSync(getDeviceLockPath(name))).toBe(false);
        expect(readFileSync(path.join(avd, 'userdata-qemu.img'), 'utf8')).toBe('preserved');
        for (const lock of emulatorLocks) {
          expect(existsSync(path.join(avd, lock))).toBe(scenario !== 'stopped');
        }
        if (result.ok) {
          const registry = JSON.parse(readFileSync(path.join(tempDir, 'devices.json'), 'utf8'));
          expect(registry.devices[name].containerId).toBe(containerId.substring(0, 12));
          expect(registry.devices[name].status).toBe('running');
        } else if (scenario === 'create-error') {
          const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
          expect(registry.devices[name].status).toBe('stopped');
          expect(registry.devices[name].containerId).toBeUndefined();
        }
        await executeDeviceAction('delete', name, { force: true });
      }
      for (const scenario of ['stop-error', 'shutdown-error', 'shutdown-timeout', 'stale-stop']) {
        const name = `resume-${scenario}`;
        writeFileSync(state, 'running');
        expect(
          (
            await executeDeviceAction('create', name, {
              port: 65493,
              image: scenario === 'stale-stop' ? LOCAL_AOSP_IMAGE : DEFAULT_IMAGE,
            })
          ).ok,
        ).toBe(true);
        expect((await executeDeviceAction('start', name, { force: true })).ok).toBe(true);
        writeFileSync(state, scenario);
        if (scenario === 'stale-stop') {
          const registryPath = path.join(tempDir, 'devices.json');
          const stale = JSON.parse(readFileSync(registryPath, 'utf8'));
          stale.devices[name].status = 'stopped';
          stale.devices[name].containerId = 'stale-id';
          writeFileSync(registryPath, JSON.stringify(stale));
          writeFileSync(commands, '');
        }
        const stopped = await executeDeviceAction('stop', name, {
          json: scenario.startsWith('shutdown-'),
        });
        expect(stopped.ok).toBe(scenario !== 'stop-error');
        const registry = JSON.parse(readFileSync(path.join(tempDir, 'devices.json'), 'utf8'));
        expect(registry.devices[name].status).toBe(
          scenario === 'stop-error' ? 'running' : 'stopped',
        );
        if (scenario === 'shutdown-error') {
          expect(stopped.message).toContain('could not be confirmed');
          expect(stopped.message).toContain('Shutdown command exited with code 125.');
          expect(stopped.data).toEqual(JSON.parse(stopped.message));
        }
        if (scenario === 'shutdown-timeout') {
          expect(stopped.message).toContain('Shutdown command exceeded the 15-second limit.');
          expect(stopped.data).toEqual(JSON.parse(stopped.message));
          expect(readFileSync(commands, 'utf8')).toContain(`stop awrit-android-${name}`);
        }
        if (scenario === 'stale-stop') {
          expect(readFileSync(commands, 'utf8')).toContain(
            `exec --user androidusr -e HOME=/home/androidusr awrit-android-${name}`,
          );
          expect(registry.devices[name].containerId).toBe(containerId.substring(0, 12));
        }
        await executeDeviceAction('delete', name, { force: true });
      }
    } finally {
      process.env.PATH = previousPath;
      rmSync(bin, { recursive: true, force: true });
    }
  }, 30000);

  test('ADB readiness checks device state instead of trusting connect exit status', async () => {
    const adb = path.join(tempDir, 'fake-adb');
    writeFileSync(adb, '#!/bin/sh\nif [ "$1" = devices ]; then printf "serial\\tdevice\\n"; fi\n', {
      mode: 0o755,
    });
    expect(await waitForAdb(adb, 'serial', 1000)).toBe(true);
    writeFileSync(adb, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    expect(await waitForAdb(adb, 'serial', 50)).toBe(false);
    expect(await waitForAdb('/nonexistent/adb', 'serial', 50)).toBe(false);
  });

  test('view action resolves device name to exact serial and handles missing name', async () => {
    const noNameRes = await executeDeviceAction('view');
    expect(noNameRes.ok).toBe(false);
    expect(noNameRes.message).toContain('required for view');

    const jsonNoName = await executeDeviceAction('view', undefined, { json: true });
    expect(jsonNoName.ok).toBe(false);
    expect(JSON.parse(jsonNoName.message).error).toContain('required for view');

    // Create a device to test resolution
    await executeDeviceAction('create', 'view-test-phone', { port: 5592 });
    const viewRes = await executeDeviceAction('view', 'view-test-phone');
    expect(viewRes.ok).toBe(true);
    expect(viewRes.data.serial).toBe('127.0.0.1:5592');

    const jsonViewRes = await executeDeviceAction('view', 'view-test-phone', { json: true });
    expect(jsonViewRes.ok).toBe(true);
    const parsed = JSON.parse(jsonViewRes.message);
    expect(parsed.serial).toBe('127.0.0.1:5592');

    await executeDeviceAction('delete', 'view-test-phone', { force: true });
  });

  test('getDeviceLogPath resolves log file path within app data logs directory', () => {
    const logPath = getDeviceLogPath('test-phone-logging');
    expect(typeof logPath).toBe('string');
    expect(logPath.endsWith(path.join('logs', 'test-phone-logging.log'))).toBe(true);
  });

  test('getDeviceLockPath resolves lock file path within app data locks directory', () => {
    const lockPath = getDeviceLockPath('test-phone-locking');
    expect(typeof lockPath).toBe('string');
    expect(lockPath.endsWith(path.join('locks', 'test-phone-locking.lock'))).toBe(true);
  });

  test('screenshot action handles missing or offline device gracefully in text and json mode', async () => {
    const textRes = await executeDeviceAction('screenshot', 'offline-ghost-device');
    expect(textRes.ok).toBe(false);
    expect(textRes.message).toContain('offline-ghost-device');

    const jsonRes = await executeDeviceAction('screenshot', 'offline-ghost-device', { json: true });
    expect(jsonRes.ok).toBe(false);
    const parsed = JSON.parse(jsonRes.message);
    expect(parsed.error).toContain('offline-ghost-device');
  });

  test('install action rejects missing or non-existent APK file gracefully', async () => {
    const noApkRes = await executeDeviceAction('install');
    expect(noApkRes.ok).toBe(false);
    expect(noApkRes.message).toContain('APK file path is required');

    const jsonNoApk = await executeDeviceAction('install', undefined, { json: true });
    expect(jsonNoApk.ok).toBe(false);
    expect(JSON.parse(jsonNoApk.message).error).toContain('APK file path is required');

    const missingApk = await installApkToDevice('/non/existent/package.apk');
    expect(missingApk.ok).toBe(false);
    expect(missingApk.message).toContain('APK file not found');
  });

  test('reverse action validates port mapping and handles errors gracefully', async () => {
    const noPortRes = await executeDeviceAction('reverse');
    expect(noPortRes.ok).toBe(false);
    expect(noPortRes.message).toContain('Port mapping is required');

    const jsonNoPort = await executeDeviceAction('reverse', undefined, { json: true });
    expect(jsonNoPort.ok).toBe(false);
    expect(JSON.parse(jsonNoPort.message).error).toContain('Port mapping is required');

    const invalidPort = await reverseDevicePort(0, 0);
    expect(invalidPort.ok).toBe(false);
    expect(invalidPort.message).toContain('Valid remote and local ports');
  });

  test('install and reverse fail fast on an offline device', async () => {
    const apk = path.join(tempDir, 'x.apk');
    writeFileSync(apk, 'x');
    const t0 = Date.now();
    const rev = await reverseDevicePort(8080, 8080, 'ghost-device');
    const inst = await installApkToDevice(apk, 'ghost-device');
    expect(rev.ok).toBe(false);
    expect(rev.message).toContain('not connected');
    expect(inst.ok).toBe(false);
    expect(inst.message).toContain('not connected');
    expect(Date.now() - t0).toBeLessThan(4000);
  });

  test('default image is pinned by digest only (podman rejects tag+digest)', async () => {
    expect(DEFAULT_IMAGE).toMatch(/^docker\.io\/[\w./-]+@sha256:[0-9a-f]{64}$/);
    const res = await executeDeviceAction('create', 'pinned-default', { json: true, port: 65494 });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.message).image).toBe(DEFAULT_IMAGE);
    await executeDeviceAction('delete', 'pinned-default', { force: true });
  });

  test('logcat action handles missing or offline devices and options gracefully', async () => {
    const offlineLogcat = await captureDeviceLogcat(10, undefined, 'offline-ghost-device');
    expect(offlineLogcat.ok).toBe(false);
    expect(offlineLogcat.error).toBeDefined();

    const jsonLogcatErr = await executeDeviceAction('logcat', 'offline-ghost-device', {
      json: true,
    });
    expect(jsonLogcatErr.ok).toBe(false);
    const parsed = JSON.parse(jsonLogcatErr.message);
    expect(parsed.error).toBeDefined();
  });
});
