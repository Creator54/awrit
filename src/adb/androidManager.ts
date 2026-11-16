import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  accessSync,
  appendFileSync,
  closeSync,
  constants,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { getAppDataPath } from '../paths';
import { findBinary } from './adbControl';
import {
  buildImage,
  type ContainerState,
  type ContainerSummary,
  inspectContainer,
  listContainers,
  PodmanError,
  PodmanFailure,
  podmanAvailable,
  podmanBinary,
  podmanExec,
  podmanVersion,
  removeContainer,
  runPodman,
  stopContainer,
} from './podman';
import { selectManagedRuntime, type ManagedRuntimeDecision, type KvmStatus } from './runtimeSelection';

export type { KvmStatus } from './runtimeSelection';

// Pinned by digest (emulator_13.0 at pin time) so `create` is reproducible. Podman rejects
// tag+digest references, so the tag is omitted. Re-resolve the tag's digest to update.
export const DEFAULT_IMAGE =
  'docker.io/budtmo/docker-android@sha256:ad9a868bcdd8e004f2212b777efc3ae9e0a8d87e0636d10f8e05e70df85762bc';

export const LOCAL_AOSP_IMAGE = 'localhost/awrit-android-aosp:latest';

function isDockerAndroidImage(image: string): boolean {
  return image === LOCAL_AOSP_IMAGE || /^docker\.io\/budtmo\/docker-android[:@]/.test(image);
}

// This image assumes rootful Docker and chowns /dev/kvm unconditionally.
// Keep its permission check when access is missing; rootless users cannot chown host devices.
// The image also leaves /home/androidusr owned by root, so fix the writable parts as root and then drop to androidusr.
export const ROOTLESS_ANDROID_START = `python3 - <<'PY'
from pathlib import Path
p = Path('/home/androidusr/docker-android/cli/src/device/emulator.py')
s = p.read_text()
old = '    def change_permission(self) -> None:\\n'
guard = old + '        if os.access("/dev/kvm", os.R_OK | os.W_OK):\\n            return\\n'
if guard not in s:
    if s.count(old) != 1:
        raise RuntimeError('Unsupported docker-android permission check')
    p.write_text(s.replace(old, guard, 1))
PY
if [ "$?" -ne 0 ]; then exit 1; fi
chown androidusr:androidusr /home/androidusr
chown -R androidusr:androidusr /home/androidusr/logs /home/androidusr/.android /home/androidusr/.config
exec setpriv --reuid=androidusr --regid=androidusr --init-groups env HOME=/home/androidusr /home/androidusr/docker-android/mixins/scripts/run.sh`;

export async function waitForAdb(
  adbBin: string,
  serial: string,
  timeoutMs = 180_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connected = await new Promise<boolean>((resolve) => {
      const proc = spawn(adbBin, ['connect', serial]);
      const timer = setTimeout(
        () => {
          proc.kill('SIGKILL');
          resolve(false);
        },
        Math.min(5000, Math.max(1, deadline - Date.now())),
      );
      proc.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      proc.on('close', () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    if (connected && (await listConnectedAdbDevices(adbBin)).includes(serial)) return true;
    if (Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, deadline - Date.now())));
  }
  return false;
}

export interface DeviceProfile {
  name: string;
  type: 'podman' | 'emulator' | 'physical';
  containerId?: string;
  serial?: string;
  port?: number;
  status: 'running' | 'stopped' | 'offline';
  image?: string;
  deviceModel?: string;
  resolution?: DeviceResolution;
  createdAt: number;
}

export type DeviceResolution = { width: number; height: number; density?: number };

export type ContainerGroupState = 'running' | 'stopped' | 'missing';

export interface OrphanContainer {
  name: string;
  containerId: string;
  running: boolean;
  state: 'orphan';
}

const DEVICE_CONTAINER_PREFIX = 'awrit-android-';

export function deviceContainerName(name: string): string {
  return `${DEVICE_CONTAINER_PREFIX}${name}`;
}

/** True when nothing already listens on the ADB port. The registry cannot see other processes. */
export async function isHostPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen({ port, host: '127.0.0.1', exclusive: true });
  });
}

/**
 * Registry entries are the source of truth and Podman supplies the container state. Entries match
 * containers by name, so containers created before labelling still count. Only a labelled
 * container without a registry entry is an orphan; a registry entry without a container is
 * missing. Pass null when Podman is unavailable so the state stays unknown, not "missing".
 */
export function mergeManagedDevices(
  devices: DeviceProfile[],
  containers: ContainerSummary[] | null,
): {
  merged: { profile: DeviceProfile; containerState?: ContainerGroupState }[];
  orphans: OrphanContainer[];
} {
  const unmatched = new Map((containers ?? []).map((container) => [container.name, container]));
  const merged = devices.map((profile) => {
    const containerName = deviceContainerName(profile.name);
    const container = unmatched.get(containerName);
    if (container) unmatched.delete(containerName);
    if (containers === null || profile.type !== 'podman') return { profile };
    return {
      profile,
      containerState: container ? (container.running ? 'running' : 'stopped') : 'missing',
    } as const;
  });
  const orphans = [...unmatched.values()]
    .filter((container) => container.managed)
    .map((container) => ({
      name: container.name,
      containerId: container.id,
      running: container.running,
      state: 'orphan' as const,
    }));
  return { merged, orphans };
}

export type ResolutionResult =
  | { ok: true; resolution: DeviceResolution | undefined }
  | { ok: false; error: string };

const RESOLUTION_SIZE_MIN = 320;
const RESOLUTION_SIZE_MAX = 8192;
const RESOLUTION_DPI_MIN = 72;
const RESOLUTION_DPI_MAX = 640;

/** Accepted resolution format, quoted in every rejection so callers know what to send. */
export const RESOLUTION_FORMAT =
  `widthxheight[@dpi], e.g. 1080x1920@420 (width and height ${RESOLUTION_SIZE_MIN}-${RESOLUTION_SIZE_MAX}, dpi ${RESOLUTION_DPI_MIN}-${RESOLUTION_DPI_MAX})`;

/**
 * Single validator for every device-creation path. Accepts the CLI string form or an
 * already-parsed object, so malformed values fail loudly instead of falling back to defaults.
 */
export function parseResolution(input: unknown): ResolutionResult {
  if (input === undefined || input === null) return { ok: true, resolution: undefined };

  let width: unknown;
  let height: unknown;
  let density: unknown;
  if (typeof input === 'string') {
    const match = /^(\d+)x(\d+)(?:@(\d+))?$/.exec(input.trim());
    if (!match) return { ok: false, error: `Invalid resolution '${input}'. Use ${RESOLUTION_FORMAT}.` };
    width = Number(match[1]);
    height = Number(match[2]);
    density = match[3] === undefined ? undefined : Number(match[3]);
  } else if (typeof input === 'object') {
    const value = input as Record<string, unknown>;
    width = value.width;
    height = value.height;
    density = value.density ?? undefined;
  } else {
    return { ok: false, error: `Invalid resolution. Use ${RESOLUTION_FORMAT}.` };
  }

  const inRange = (value: unknown, min: number, max: number): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

  if (!inRange(width, RESOLUTION_SIZE_MIN, RESOLUTION_SIZE_MAX) ||
    !inRange(height, RESOLUTION_SIZE_MIN, RESOLUTION_SIZE_MAX) ||
    (density !== undefined && !inRange(density, RESOLUTION_DPI_MIN, RESOLUTION_DPI_MAX))) {
    return { ok: false, error: `Invalid resolution. Use ${RESOLUTION_FORMAT}.` };
  }

  return { ok: true, resolution: { width, height, ...(density === undefined ? {} : { density }) } };
}

export interface AndroidRegistry {
  version: 1;
  devices: Record<string, DeviceProfile>;
}

export function ensureContainerAuthFile(): string {
  const authPath = path.join(getAppDataPath(), 'containers-auth.json');
  try {
    if (!existsSync(authPath)) {
      const dir = path.dirname(authPath);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(authPath, '{}\n', 'utf8');
    }
  } catch (_e) {}
  return authPath;
}

export function getDeviceLogPath(deviceName: string): string {
  const dir = path.join(getAppDataPath(), 'logs');
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (_e) {}
  }
  return path.join(dir, `${deviceName}.log`);
}

export function getLocksDir(): string {
  const dir = path.join(getAppDataPath(), 'locks');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getDeviceLockPath(deviceName: string): string {
  return path.join(getLocksDir(), `${deviceName}.lock`);
}

export interface DeviceLockHandle {
  lockPath: string;
  token: string;
  release: () => void;
}

export function parseLockFile(content: string): { pid: number; token?: string } | null {
  const trimmed = content.trim();
  if (!trimmed) return null;
  const firstLine = trimmed.split('\n')[0].trim();
  const parts = firstLine.split(':');
  const pid = parseInt(parts[0], 10);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return { pid, token: parts[1] || undefined };
}

function isProcessGone(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (err: unknown) {
    return (err as { code?: string })?.code === 'ESRCH';
  }
}

/** Lock files whose owning process has exited. Nothing is deleted here. */
export function listLeftoverDeviceLocks(): { device: string; path: string }[] {
  let entries: string[];
  try {
    entries = readdirSync(getLocksDir());
  } catch (_e) {
    return [];
  }
  return entries
    .filter((entry) => entry.endsWith('.lock'))
    .flatMap((entry) => {
      try {
        const lockPath = path.join(getLocksDir(), entry);
        const parsed = parseLockFile(readFileSync(lockPath, 'utf8'));
        if (!parsed || !isProcessGone(parsed.pid)) return [];
        return [{ device: entry.slice(0, -'.lock'.length), path: lockPath }];
      } catch (_e) {
        return [];
      }
    });
}

export function cleanStaleDeviceLock(name: string): boolean {
  const lockFile = getDeviceLockPath(name);
  try {
    const content = readFileSync(lockFile, 'utf8');
    const parsed = parseLockFile(content);
    if (!parsed || !isProcessGone(parsed.pid)) return false;
    try {
      const current = readFileSync(lockFile, 'utf8');
      if (current === content) {
        unlinkSync(lockFile);
        return true;
      }
    } catch (_e) {}
    return false;
  } catch (_e) {
    return false;
  }
}

export function acquireDeviceLock(name: string): {
  ok: boolean;
  message?: string;
  handle?: DeviceLockHandle;
} {
  let lockFile: string;
  try {
    lockFile = getDeviceLockPath(name);
  } catch (error) {
    return { ok: false, message: `Failed to create device lock directory: ${String(error)}` };
  }
  const token = randomBytes(16).toString('hex');
  const lockData = `${process.pid}:${token}\n`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockFile, 'wx', 0o600);
      try {
        writeFileSync(fd, lockData, 'utf8');
      } finally {
        closeSync(fd);
      }

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try {
          const content = readFileSync(lockFile, 'utf8');
          const parsed = parseLockFile(content);
          if (parsed && parsed.token === token) {
            unlinkSync(lockFile);
          }
        } catch (_e) {}
      };

      return {
        ok: true,
        handle: { lockPath: lockFile, token, release },
      };
    } catch (err: unknown) {
      const code = (err as { code?: string })?.code;
      if (code === 'EEXIST') {
        if (attempt === 0 && cleanStaleDeviceLock(name)) {
          continue;
        }
        let holderPid: number | undefined;
        try {
          const parsed = parseLockFile(readFileSync(lockFile, 'utf8'));
          if (parsed) holderPid = parsed.pid;
        } catch (_e) {}
        const pidMsg = holderPid ? ` by process ${holderPid}` : '';
        return {
          ok: false,
          message: `Device '${name}' start is already in progress${pidMsg}.`,
        };
      }
      return {
        ok: false,
        message: `Failed to acquire lock for device '${name}': ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  return {
    ok: false,
    message: `Device '${name}' start is already in progress.`,
  };
}

export function getRegistryPath(): string {
  if (process.env.AWRIT_ANDROID_REGISTRY_PATH) {
    return process.env.AWRIT_ANDROID_REGISTRY_PATH;
  }
  return path.join(getAppDataPath(), 'android-devices.json');
}

function readFreeMemMb(): number {
  if (process.platform === 'linux' && existsSync('/proc/meminfo')) {
    try {
      for (const line of readFileSync('/proc/meminfo', 'utf8').split('\n')) {
        if (line.startsWith('MemAvailable:')) return Math.round(parseInt(line.split(/\s+/)[1], 10) / 1024);
      }
    } catch (_e) {}
    return 0;
  }
  // Cross-platform fallback (macOS, Windows)
  return Math.round(require('node:os').freemem() / (1024 * 1024));
}

/** Possible boot delays; registry status is a hint, not a live container check. */
export function slowBootHint(name: string): string {
  const hints: string[] = [];
  const freeMb = readFreeMemMb();
  if (freeMb > 0 && freeMb < 3072) hints.push(`Only ${freeMb} MB memory is free.`);
  const others = Object.entries(loadRegistry().devices)
    .filter(([n, d]) => n !== name && d.status === 'running')
    .map(([n]) => n);
  if (others.length) hints.push(`'${others[0]}' is marked running (awrit device stop ${others[0]}).`);
  return hints.join(' ');
}

export function getAdbSerialForDevice(target: string): string {
  const registry = loadRegistry();
  const dev = registry.devices[target];
  if (dev?.serial) {
    return dev.serial;
  }
  return target;
}

export function loadRegistry(): AndroidRegistry {
  const regPath = getRegistryPath();
  try {
    if (existsSync(regPath)) {
      const data = JSON.parse(readFileSync(regPath, 'utf8'));
      if (data && data.version === 1 && typeof data.devices === 'object') {
        return data as AndroidRegistry;
      }
    }
  } catch (_e) {}
  return { version: 1, devices: {} };
}

export function saveRegistry(registry: AndroidRegistry): void {
  const regPath = getRegistryPath();
  const dir = path.dirname(regPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmpPath = `${regPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, JSON.stringify(registry, null, 2), 'utf8');
  renameSync(tmpPath, regPath);
}

// Keep the read/modify/write section synchronous: container and ADB work must
// happen outside this lock so unrelated devices are not blocked during boot.
export async function updateRegistry<T>(update: (registry: AndroidRegistry) => T): Promise<T> {
  const lockPath = `${getRegistryPath()}.lock`;
  mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 5000;
  let fd: number;
  for (;;) {
    try {
      fd = openSync(lockPath, 'wx', 0o600);
      break;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
      if (Date.now() >= deadline) {
        throw new Error(`Android registry is locked: ${lockPath}. Check for an interrupted registry writer before removing the lock.`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  try {
    const registry = loadRegistry();
    const result = update(registry);
    saveRegistry(registry);
    return result;
  } finally {
    closeSync(fd);
    unlinkSync(lockPath);
  }
}

// Managed images bundle x86_64 system images (containers/android-aosp/Containerfile).
export const EMULATOR_IMAGE_ARCH = 'x86_64';

const KVM_DEVICE = '/dev/kvm';

export interface DoctorEnvironment {
  kvmExists: (devicePath: string) => boolean;
  kvmReadWrite: (devicePath: string) => boolean;
  hostArch: string;
  platform?: string;
}

const hostEnvironment: DoctorEnvironment = {
  kvmExists: (devicePath) => existsSync(devicePath),
  kvmReadWrite: (devicePath) => {
    try {
      accessSync(devicePath, constants.R_OK | constants.W_OK);
      return true;
    } catch {
      return false;
    }
  },
  hostArch: process.arch,
  platform: process.platform,
};

function normalizeArch(arch: string): string {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'ia32') return 'x86';
  return arch;
}

export async function runDoctor(environment: DoctorEnvironment = hostEnvironment): Promise<{
  kvm: boolean;
  kvmStatus: KvmStatus;
  hostArch: string;
  imageArch: string;
  archSupported: boolean;
  podman: boolean;
  podmanVersion?: string;
  adb: boolean;
  ffmpeg: boolean;
  freeMemMb: number;
  freeDiskMb?: number;
  runtimeSelection: ManagedRuntimeDecision;
}> {
  const kvmStatus: KvmStatus = !environment.kvmExists(KVM_DEVICE)
    ? 'missing'
    : environment.kvmReadWrite(KVM_DEVICE)
      ? 'ready'
      : 'permission-denied';
  const hostArch = normalizeArch(environment.hostArch);
  const adbPath = findBinary('adb');
  const ffmpegPath = findBinary('ffmpeg', [
    '/run/current-system/sw/bin/ffmpeg',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ]);
  const podmanVersionText = await podmanVersion();
  const podmanOk = podmanVersionText !== undefined;

  const freeMemMb = readFreeMemMb();

  let freeDiskMb: number | undefined;
  try {
    const stats = statfsSync(getAppDataPath());
    freeDiskMb = Math.round((Number(stats.bavail) * Number(stats.bsize)) / (1024 * 1024));
  } catch (_e) {}

  const adbOk = existsSync(adbPath);
  const ffmpegOk = existsSync(ffmpegPath);
  const platform = environment.platform ?? process.platform;
  const runtimeSelection = selectManagedRuntime({
    platform,
    hostArch,
    kvmStatus,
    podman: podmanOk,
    adb: adbOk,
    ffmpeg: ffmpegOk,
  });

  return {
    kvm: kvmStatus === 'ready',
    kvmStatus,
    hostArch,
    imageArch: EMULATOR_IMAGE_ARCH,
    archSupported: hostArch === EMULATOR_IMAGE_ARCH,
    podman: podmanOk,
    podmanVersion: podmanVersionText,
    adb: adbOk,
    ffmpeg: ffmpegOk,
    freeMemMb,
    freeDiskMb,
    runtimeSelection,
  };
}

export async function listConnectedAdbDevices(adbBin = 'adb'): Promise<string[]> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    let proc: any = null;
    try {
      proc = spawn(adbBin, ['devices']);
    } catch (_e) {
      return resolve([]);
    }

    timer = setTimeout(() => {
      try {
        proc?.kill('SIGKILL');
      } catch (_e) {}
      resolve([]);
    }, 3000);

    let out = '';
    proc.stdout?.on('data', (d: any) => {
      out += d.toString();
    });
    proc.on('close', () => {
      if (timer) clearTimeout(timer);
      const result: string[] = [];
      for (const line of out.split('\n')) {
        const parts = line.trim().split(/\s+/);
        if (parts.length >= 2 && parts[1] === 'device') {
          result.push(parts[0]);
        }
      }
      resolve(result);
    });
    proc.on('error', () => {
      if (timer) clearTimeout(timer);
      resolve([]);
    });
  });
}

export async function captureDeviceScreenshot(
  serial?: string,
): Promise<{ ok: boolean; base64?: string; error?: string }> {
  const adbBin = findBinary('adb');
  const connected = await listConnectedAdbDevices(adbBin);
  const target = serial ? getAdbSerialForDevice(serial) : connected[0] || '';
  if (!target) {
    return { ok: false, error: 'No Android device connected' };
  }
  if (!connected.includes(target)) {
    return { ok: false, error: `Device '${target}' is not connected` };
  }

  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    let proc: any = null;
    try {
      proc = spawn(adbBin, ['-s', target, 'exec-out', 'screencap', '-p']);
    } catch (e: any) {
      return resolve({ ok: false, error: e?.message || 'Failed to spawn adb screencap' });
    }

    const chunks: Buffer[] = [];
    timer = setTimeout(() => {
      try {
        proc?.kill('SIGKILL');
      } catch (_e) {}
      resolve({ ok: false, error: 'Screenshot timeout after 5000ms' });
    }, 5000);

    proc.stdout?.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on('close', (code: number) => {
      if (timer) clearTimeout(timer);
      if (code === 0 && chunks.length > 0) {
        const fullBuf = Buffer.concat(chunks);
        resolve({ ok: true, base64: fullBuf.toString('base64') });
      } else {
        const detail = stderr.trim() || `screencap exited with code ${code}`;
        resolve({ ok: false, error: `Device '${target}': ${detail}` });
      }
    });

    proc.on('error', (err: any) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, error: err?.message || 'screencap process error' });
    });
  });
}

export async function installApkToDevice(
  apkPath: string,
  serial?: string,
): Promise<{ ok: boolean; message: string; error?: string }> {
  if (!apkPath || typeof apkPath !== 'string') {
    return { ok: false, message: 'APK file path is required for install' };
  }
  const resolvedApk = path.resolve(process.cwd(), apkPath);
  if (!existsSync(resolvedApk)) {
    return { ok: false, message: `APK file not found: ${resolvedApk}` };
  }

  const adbBin = findBinary('adb');
  const connected = await listConnectedAdbDevices(adbBin);
  const target = serial ? getAdbSerialForDevice(serial) : connected[0] || '';
  if (!target) {
    return { ok: false, message: 'No Android device connected for install' };
  }
  if (!connected.includes(target)) {
    return { ok: false, message: `Device '${target}' is not connected` };
  }

  return new Promise((resolve) => {
    let proc: any = null;
    let timer: NodeJS.Timeout | null = null;
    try {
      proc = spawn(adbBin, ['-s', target, 'install', '-r', resolvedApk]);
    } catch (e: any) {
      return resolve({
        ok: false,
        message: `Failed to spawn adb install: ${e?.message}`,
        error: e?.message,
      });
    }

    timer = setTimeout(() => {
      try {
        proc?.kill('SIGKILL');
      } catch (_e) {}
      resolve({
        ok: false,
        message: `Install timed out after 60s on device '${target}'`,
        error: 'timeout',
      });
    }, 60000);

    let out = '';
    let err = '';
    proc.stdout?.on('data', (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    proc.on('close', (code: number) => {
      if (timer) clearTimeout(timer);
      const combined = `${out}\n${err}`.trim();
      if (code === 0 && combined.includes('Success')) {
        resolve({
          ok: true,
          message: `Installed ${path.basename(resolvedApk)} on ${target}.`,
        });
      } else {
        const failureReason = combined || `exit code ${code}`;
        resolve({
          ok: false,
          message: `Failed to install APK on ${target}: ${failureReason}`,
          error: failureReason,
        });
      }
    });
    proc.on('error', (e: any) => {
      if (timer) clearTimeout(timer);
      resolve({
        ok: false,
        message: `Install failed: ${e?.message}`,
        error: e?.message,
      });
    });
  });
}

export async function reverseDevicePort(
  remotePort: number,
  localPort: number,
  serial?: string,
): Promise<{ ok: boolean; message: string; error?: string }> {
  if (!remotePort || !localPort || remotePort < 1 || localPort < 1) {
    return { ok: false, message: 'Valid remote and local ports are required (e.g. 8080:8080)' };
  }
  const adbBin = findBinary('adb');
  const connected = await listConnectedAdbDevices(adbBin);
  const target = serial ? getAdbSerialForDevice(serial) : connected[0] || '';
  if (!target) {
    return { ok: false, message: 'No Android device connected for port reverse' };
  }
  if (!connected.includes(target)) {
    return { ok: false, message: `Device '${target}' is not connected` };
  }

  return new Promise((resolve) => {
    let proc: any = null;
    let timer: NodeJS.Timeout | null = null;
    try {
      proc = spawn(adbBin, ['-s', target, 'reverse', `tcp:${remotePort}`, `tcp:${localPort}`]);
    } catch (e: any) {
      return resolve({
        ok: false,
        message: `Failed to spawn adb reverse: ${e?.message}`,
        error: e?.message,
      });
    }

    timer = setTimeout(() => {
      try {
        proc?.kill('SIGKILL');
      } catch (_e) {}
      resolve({
        ok: false,
        message: `Reverse port timed out after 10s on device '${target}'`,
        error: 'timeout',
      });
    }, 10000);

    let err = '';
    proc.stderr?.on('data', (d: Buffer) => {
      err += d.toString();
    });
    proc.on('close', (code: number) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        resolve({
          ok: true,
          message: `Forwarded device tcp:${remotePort} -> host tcp:${localPort} on ${target}.`,
        });
      } else {
        const failureReason = err.trim() || `exit code ${code}`;
        resolve({
          ok: false,
          message: `Failed to reverse port on ${target}: ${failureReason}`,
          error: failureReason,
        });
      }
    });
    proc.on('error', (e: any) => {
      if (timer) clearTimeout(timer);
      resolve({
        ok: false,
        message: `Port mapping failed: ${e?.message}`,
        error: e?.message,
      });
    });
  });
}

export async function captureDeviceLogcat(
  lines = 100,
  filter?: string,
  serial?: string,
): Promise<{ ok: boolean; logs?: string[]; error?: string }> {
  const adbBin = findBinary('adb');
  const connected = await listConnectedAdbDevices(adbBin);
  const target = serial ? getAdbSerialForDevice(serial) : connected[0] || '';
  if (!target) {
    return { ok: false, error: 'No Android device connected for logcat' };
  }
  if (!connected.includes(target)) {
    return { ok: false, error: `Device '${target}' is not connected` };
  }

  const lineCount = Math.max(1, Math.min(1000, lines));
  const args = ['-s', target, 'logcat', '-d', '-t', String(lineCount)];
  if (filter && typeof filter === 'string' && filter.trim().length > 0) {
    args.push(filter.trim());
  }

  return new Promise((resolve) => {
    let proc: any = null;
    let timer: NodeJS.Timeout | null = null;
    try {
      proc = spawn(adbBin, args);
    } catch (e: any) {
      return resolve({ ok: false, error: e?.message || 'Failed to spawn adb logcat' });
    }

    timer = setTimeout(() => {
      try {
        proc?.kill('SIGKILL');
      } catch (_e) {}
      resolve({ ok: false, error: `Logcat query timed out on device '${target}'` });
    }, 8000);

    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    proc.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    proc.on('close', (code: number) => {
      if (timer) clearTimeout(timer);
      if (code === 0) {
        const logLines = stdout.split('\n').filter((l) => l.length > 0);
        resolve({ ok: true, logs: logLines });
      } else {
        const detail = stderr.trim() || `exit code ${code}`;
        resolve({ ok: false, error: `Device '${target}': ${detail}` });
      }
    });
    proc.on('error', (e: any) => {
      if (timer) clearTimeout(timer);
      resolve({ ok: false, error: e?.message || 'logcat process error' });
    });
  });
}

export const LOCAL_IMAGE = 'localhost/awrit-android:latest';

function findContainerfile(): string | null {
  const candidates = [
    process.env.AWRIT_CONTAINERFILE,
    path.join(__dirname, '../containers/android-emulator/Containerfile'),
    path.join(__dirname, '../../containers/android-emulator/Containerfile'),
  ];
  return candidates.find((c): c is string => !!c && existsSync(c)) ?? null;
}

/**
 * Builds the local emulator image. Validates every input before touching Podman so a missing
 * license acceptance or checksum never starts a download.
 */
export async function buildEmulatorImage(opts: {
  acceptLicense?: boolean;
  toolsUrl?: string;
  toolsSha256?: string;
}): Promise<{ ok: boolean; message: string }> {
  if (!opts.acceptLicense) {
    return {
      ok: false,
      message:
        'Refusing to build: read the Android SDK license, then pass --accept-license to confirm.',
    };
  }
  if (!opts.toolsUrl || !/^https:\/\/\S+$/.test(opts.toolsUrl)) {
    return {
      ok: false,
      message: '--tools-url must be an https URL to the command-line-tools zip.',
    };
  }
  if (!opts.toolsSha256 || !/^[0-9a-fA-F]{64}$/.test(opts.toolsSha256)) {
    return { ok: false, message: '--tools-sha256 must be a 64-character hex SHA-256.' };
  }
  const containerfile = findContainerfile();
  if (!containerfile) {
    return { ok: false, message: 'Containerfile not found (set AWRIT_CONTAINERFILE to override).' };
  }
  if (!podmanAvailable()) return { ok: false, message: 'Podman binary not found on PATH.' };

  const args = [
    '-f',
    containerfile,
    '-t',
    LOCAL_IMAGE,
    '--build-arg',
    'ACCEPT_ANDROID_SDK_LICENSE=yes',
    '--build-arg',
    `CMDLINE_TOOLS_URL=${opts.toolsUrl}`,
    '--build-arg',
    `CMDLINE_TOOLS_SHA256=${opts.toolsSha256.toLowerCase()}`,
    path.dirname(containerfile),
  ];
  let code: number;
  try {
    code = await buildImage(args);
  } catch (error) {
    return {
      ok: false,
      message:
        error instanceof PodmanError
          ? error.message
          : `Podman execution error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return code === 0
    ? {
        ok: true,
        message: `Built ${LOCAL_IMAGE}. The bundled SDK recipe needs a system image, AVD, and startup entrypoint before it can run Android.`,
      }
    : { ok: false, message: `podman build failed (exit ${code}).` };
}

export async function executeDeviceAction(
  cmd:
    | 'doctor'
    | 'list'
    | 'show'
    | 'prune'
    | 'create'
    | 'start'
    | 'stop'
    | 'delete'
    | 'view'
    | 'screenshot'
    | 'install'
    | 'reverse'
    | 'logcat'
    | 'build',
  name?: string,
  extraArgs: Record<string, any> = {},
): Promise<{ ok: boolean; message: string; data?: any }> {
  const adbBin = findBinary('adb');

  if (cmd === 'doctor') {
    const doc = await runDoctor();
    const isReady = doc.runtimeSelection.status === 'ready';
    if (extraArgs.json) {
      return { ok: isReady, message: JSON.stringify(doc), data: doc };
    }
    const kvmLine =
      doc.kvmStatus === 'ready'
        ? `✓ Ready (${KVM_DEVICE})`
        : doc.kvmStatus === 'missing'
          ? `✗ ${KVM_DEVICE} missing`
          : `✗ ${KVM_DEVICE} not readable and writable by this user`;
    const archLine = doc.archSupported
      ? `✓ ${doc.hostArch} host`
      : `✗ ${doc.hostArch} host is unsupported (managed emulator images are ${doc.imageArch} only)`;
    const runtimeLine =
      doc.runtimeSelection.status === 'ready'
        ? `✓ Ready (${doc.runtimeSelection.runtime}: ${doc.runtimeSelection.reason})`
        : doc.runtimeSelection.status === 'setup-required'
          ? `! Setup required (${doc.runtimeSelection.runtime}: ${doc.runtimeSelection.reason})`
          : `✗ Unsupported (${doc.runtimeSelection.reason})`;
    const lines = [
      'Android check:',
      `  Runtime:      ${runtimeLine}`,
      `  KVM:          ${kvmLine}`,
      `  Arch:         ${archLine}`,
      `  Podman:       ${doc.podman ? `✓ ${doc.podmanVersion?.replace(/^podman version /, '') || 'Ready'}` : '✗ Missing'}`,
      `  ADB:          ${doc.adb ? '✓ Ready' : '✗ Missing'}`,
      `  FFmpeg:       ${doc.ffmpeg ? '✓ Ready' : '✗ Missing'}`,
      `  Memory:       ${doc.freeMemMb} MB free`,
      ...(doc.freeDiskMb !== undefined ? [`  Disk:         ${doc.freeDiskMb} MB free`] : []),
    ];
    return { ok: isReady, message: lines.join('\n'), data: doc };
  }

  const registry = loadRegistry();

  if (cmd === 'show') {
    const showError = (message: string) =>
      extraArgs.json
        ? { ok: false, message: JSON.stringify({ error: message }), data: { error: message } }
        : { ok: false, message };
    if (!name) return showError('Usage: awrit device show NAME');
    const listed = await executeDeviceAction('list', undefined, { json: true });
    if (!listed.ok) return listed;
    const device = (listed.data.managed as Array<Record<string, unknown>>).find((d) => d.name === name);
    if (!device) return showError(`No device named '${name}'. Run: awrit device list`);
    if (extraArgs.json) return { ok: true, message: JSON.stringify(device), data: device };
    const lines = Object.entries(device)
      .filter(([, value]) => value !== undefined && value !== null && typeof value !== 'object')
      .map(([key, value]) => `${key}: ${value}`);
    return { ok: true, message: lines.join('\n'), data: device };
  }

  if (cmd === 'list') {
    const connected = await listConnectedAdbDevices(adbBin);
    let containers: ContainerSummary[] | null = null;
    if (podmanAvailable()) {
      try {
        containers = await listContainers();
      } catch (error) {
        return {
          ok: false,
          message: `Could not list Podman containers: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    const { merged, orphans } = mergeManagedDevices(Object.values(registry.devices), containers);
    const managed = merged.map(({ profile: d, containerState }) => ({
      ...d,
      ...(containerState ? { container: containerState } : {}),
      status:
        d.serial && connected.includes(d.serial)
          ? 'running'
          : d.status === 'running'
            ? 'offline'
            : d.status,
    }));

    if (extraArgs.json) {
      return {
        ok: true,
        message: JSON.stringify({ managed, orphans, connected }),
        data: { managed, orphans, connected },
      };
    }

    const lines: string[] = ['Android devices:'];

    if (managed.length === 0 && connected.length === 0 && orphans.length === 0) {
      lines.push('  No devices.');
    } else {
      for (const d of managed) {
        const isOnline = d.serial && connected.includes(d.serial);
        const modelInfo = d.deviceModel ? ` · ${d.deviceModel}` : '';
        const resInfo = d.resolution
          ? ` · ${d.resolution.width}×${d.resolution.height}${d.resolution.density ? `@${d.resolution.density}` : ''}`
          : '';
        const containerInfo = d.container ? ` · container ${d.container}` : '';
        lines.push(
          `  ${d.name} · ${isOnline ? 'online' : d.status}${containerInfo}${modelInfo}${resInfo}${d.serial ? ` · ${d.serial}` : ''}`,
        );
      }
      for (const c of connected) {
        const isManaged = managed.some((m) => m.serial === c);
        if (!isManaged) {
          lines.push(`  ${c} · online`);
        }
      }
      if (orphans.length > 0) {
        lines.push('Containers without a device entry:');
        for (const orphan of orphans) {
          lines.push(`  ${orphan.name} · orphan${orphan.running ? ' · running' : ' · stopped'}`);
        }
      }
    }
    return { ok: true, message: lines.join('\n'), data: { managed, orphans, connected } };
  }

  if (cmd === 'prune') {
    if (!podmanAvailable()) {
      return { ok: false, message: 'Podman binary not found on PATH.' };
    }
    let containers: ContainerSummary[];
    try {
      // Only labelled containers can be orphans; anything else is never touched.
      containers = await listContainers();
    } catch (error) {
      return {
        ok: false,
        message: `Could not list Podman containers: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const { orphans } = mergeManagedDevices(Object.values(registry.devices), containers);
    const locks = listLeftoverDeviceLocks();
    const confirmed = Boolean(extraArgs.yes);

    let removedContainers = 0;
    let removedLocks = 0;
    if (confirmed) {
      for (const orphan of orphans) {
        if (await removeContainer(orphan.name)) removedContainers += 1;
      }
      for (const lock of locks) {
        if (cleanStaleDeviceLock(lock.device)) removedLocks += 1;
      }
    }

    const data = {
      dryRun: !confirmed,
      orphans,
      locks: locks.map((lock) => lock.path),
      removed: { containers: removedContainers, locks: removedLocks },
    };
    if (extraArgs.json) {
      return { ok: true, message: JSON.stringify(data), data };
    }
    if (orphans.length === 0 && locks.length === 0) {
      return { ok: true, message: 'Nothing to prune.', data };
    }

    const lines: string[] = [];
    if (orphans.length > 0) {
      lines.push(`Orphan containers (${orphans.length}):`);
      for (const orphan of orphans) {
        lines.push(`  ${orphan.name} · ${orphan.running ? 'running' : 'stopped'}`);
      }
    }
    if (locks.length > 0) {
      lines.push(`Leftover lock files (${locks.length}):`);
      for (const lock of locks) {
        lines.push(`  ${lock.path}`);
      }
    }
    lines.push(
      confirmed
        ? `Deleted ${removedContainers} orphan container(s) and ${removedLocks} lock file(s).`
        : 'Dry run. Re-run with --yes to delete these.',
    );
    return { ok: true, message: lines.join('\n'), data };
  }

  if (cmd === 'create') {
    if (!name) {
      if (extraArgs.json) {
        return {
          ok: false,
          message: JSON.stringify({ error: 'Device name is required for create' }),
          data: { error: 'Device name is required for create' },
        };
      }
      return { ok: false, message: 'Device name is required for create' };
    }
    const res = await createDevice(name, extraArgs);
    if (extraArgs.json) {
      return {
        ok: res.ok,
        message: JSON.stringify(res.ok ? res.profile : { error: res.message }),
        data: res.profile,
      };
    }
    return { ok: res.ok, message: res.message, data: res.profile };
  }

  if (cmd === 'start') {
    if (!name) {
      if (extraArgs.json) {
        return {
          ok: false,
          message: JSON.stringify({ error: 'Device name is required for start' }),
          data: { error: 'Device name is required for start' },
        };
      }
      return { ok: false, message: 'Device name is required for start' };
    }
    const res = await startDevice(name, {
      force: Boolean(extraArgs.force),
      terminalProgress: Boolean(extraArgs.terminalProgress),
    });
    if (extraArgs.json) {
      return {
        ok: res.ok,
        message: JSON.stringify(
          res.ok ? { serial: res.serial, status: 'running' } : { error: res.message },
        ),
        data: { serial: res.serial },
      };
    }
    return { ok: res.ok, message: res.message, data: { serial: res.serial } };
  }

  if (cmd === 'stop') {
    if (!name) {
      if (extraArgs.json) {
        return {
          ok: false,
          message: JSON.stringify({ error: 'Device name is required for stop' }),
          data: { error: 'Device name is required for stop' },
        };
      }
      return { ok: false, message: 'Device name is required for stop' };
    }
    const dev = registry.devices[name];
    if (!dev) {
      if (extraArgs.json) {
        return {
          ok: false,
          message: JSON.stringify({ error: `Device '${name}' not found` }),
          data: { error: `Device '${name}' not found` },
        };
      }
      return { ok: false, message: `Device '${name}' not found` };
    }

    const targetContainer = deviceContainerName(dev.name);
    if (dev.type === 'podman') {
      let container: ContainerState | null;
      try {
        container = await inspectContainer(targetContainer);
      } catch (error) {
        return {
          ok: false,
          message: `Could not inspect '${targetContainer}': ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      let shutdownWarning = '';
      if (container?.running && isDockerAndroidImage(dev.image || DEFAULT_IMAGE)) {
        try {
          // The image's device supervisor does not restart the emulator automatically.
          await podmanExec(
            [
              'exec',
              // The emulator console token lives in androidusr's home; root is refused.
              '--user',
              'androidusr',
              '-e',
              'HOME=/home/androidusr',
              targetContainer,
              'sh',
              '-c',
              '[ ! -e /home/androidusr/emulator/hardware-qemu.ini.lock ] || { adb -s emulator-5554 emu kill && while [ -e /home/androidusr/emulator/hardware-qemu.ini.lock ]; do sleep 0.1; done; }',
            ],
            15000,
          );
        } catch (error: unknown) {
          // Report process metadata only: stderr can contain untrusted device text.
          let reason = 'Shutdown command failed.';
          if (error instanceof Error) {
            if ('killed' in error && error.killed === true) {
              reason = 'Shutdown command exceeded the 15-second limit.';
            } else if ('code' in error && typeof error.code === 'number') {
              reason = `Shutdown command exited with code ${error.code}.`;
            }
          }
          shutdownWarning =
            `The container was stopped after emulator shutdown could not be confirmed. ${reason}`;
        }
      }
      const stopped = !container?.running || (await stopContainer(targetContainer));
      if (!stopped) return { ok: false, message: `Could not stop container '${targetContainer}'.` };
      if (container) dev.containerId = container.id;
      else delete dev.containerId;
      dev.status = 'stopped';
      await updateRegistry((latest) => {
        const current = latest.devices[name];
        if (!current || current.createdAt !== dev.createdAt) throw new Error(`Device '${name}' changed while stopping.`);
        current.status = dev.status;
        if (dev.containerId) current.containerId = dev.containerId;
        else delete current.containerId;
      });

      // Disconnect ADB serial when stopping
      if (dev.serial) {
        try {
          const cp = spawn(adbBin, ['disconnect', dev.serial]);
          cp.on('close', () => {});
          cp.on('error', () => {});
        } catch (_e) {}
      }

      // Clean up lockfile if left behind by dead process
      cleanStaleDeviceLock(name);

      if (extraArgs.json) {
        const data = {
          stopped: name,
          ...(shutdownWarning ? { warning: shutdownWarning } : {}),
        };
        return { ok: true, message: JSON.stringify(data), data };
      }
      return {
        ok: true,
        message: `Stopped '${name}'.${shutdownWarning ? ` ${shutdownWarning}` : ''}`,
      };
    }
    return { ok: false, message: `Stopping device type '${dev.type}' is not supported yet.` };
  }

  if (cmd === 'delete') {
    if (!name) {
      if (extraArgs.json) {
        return {
          ok: false,
          message: JSON.stringify({ error: 'Device name is required for delete' }),
          data: { error: 'Device name is required for delete' },
        };
      }
      return { ok: false, message: 'Device name is required for delete' };
    }
    const dev = registry.devices[name];
    if (!dev) {
      if (extraArgs.json) {
        return {
          ok: false,
          message: JSON.stringify({ error: `Device '${name}' not found` }),
          data: { error: `Device '${name}' not found` },
        };
      }
      return { ok: false, message: `Device '${name}' not found` };
    }

    // Deleting a running device, or deleting without a terminal to ask, needs an explicit flag.
    const confirmed = Boolean(extraArgs.force) || Boolean(extraArgs.yes);
    if (!confirmed && (dev.status === 'running' || !process.stdin.isTTY)) {
      const error =
        dev.status === 'running'
          ? `Device '${name}' is running. Stop it first or pass --force to delete it.`
          : `Refusing to delete '${name}' without confirmation. Pass --force to delete it.`;
      if (extraArgs.json) {
        return { ok: false, message: JSON.stringify({ error }), data: { error } };
      }
      return { ok: false, message: error };
    }

    const targetContainer = dev.containerId || deviceContainerName(dev.name);
    if (dev.type === 'podman') {
      await removeContainer(targetContainer);
      // Disconnect ADB serial when deleting
      if (dev.serial) {
        try {
          const cp = spawn(adbBin, ['disconnect', dev.serial]);
          cp.on('close', () => {});
          cp.on('error', () => {});
        } catch (_e) {}
      }

      // Clean up lockfile if left behind by dead process
      cleanStaleDeviceLock(name);
    }
    await updateRegistry((latest) => {
      const current = latest.devices[name];
      if (current && current.createdAt !== dev.createdAt) throw new Error(`Device '${name}' changed while deleting.`);
      delete latest.devices[name];
    });
    if (extraArgs.json) {
      return { ok: true, message: JSON.stringify({ deleted: name }), data: { deleted: name } };
    }
    return { ok: true, message: `Deleted '${name}'.` };
  }

  if (cmd === 'view') {
    if (!name) {
      if (extraArgs.json) {
        return {
          ok: false,
          message: JSON.stringify({ error: 'Device name or serial is required for view' }),
          data: { error: 'Device name or serial is required for view' },
        };
      }
      return { ok: false, message: 'Device name or serial is required for view' };
    }
    const resolvedSerial = getAdbSerialForDevice(name);
    if (extraArgs.json) {
      return {
        ok: true,
        message: JSON.stringify({ name, serial: resolvedSerial }),
        data: { name, serial: resolvedSerial },
      };
    }
    return {
      ok: true,
      message: `Resolved device '${name}' to serial '${resolvedSerial}'`,
      data: { name, serial: resolvedSerial },
    };
  }

  if (cmd === 'screenshot') {
    const shot = await captureDeviceScreenshot(name);
    if (!shot.ok) {
      if (extraArgs.json) {
        return {
          ok: false,
          message: JSON.stringify({ error: shot.error || 'Failed to capture screenshot' }),
          data: { error: shot.error },
        };
      }
      return { ok: false, message: shot.error || 'Failed to capture screenshot' };
    }
    if (extraArgs.out && typeof extraArgs.out === 'string') {
      try {
        const outPath = path.resolve(process.cwd(), extraArgs.out);
        const parentDir = path.dirname(outPath);
        if (!existsSync(parentDir)) {
          mkdirSync(parentDir, { recursive: true });
        }
        writeFileSync(outPath, Buffer.from(shot.base64 || '', 'base64'));
        if (extraArgs.json) {
          return {
            ok: true,
            message: JSON.stringify({ file: outPath }),
            data: { file: outPath },
          };
        }
        return {
          ok: true,
          message: `Screenshot saved to ${outPath} (${Math.round(((shot.base64?.length || 0) * 0.75) / 1024)} KB).`,
          data: { file: outPath },
        };
      } catch (err: any) {
        if (extraArgs.json) {
          return {
            ok: false,
            message: JSON.stringify({ error: `Failed to save screenshot: ${err?.message}` }),
            data: { error: err?.message },
          };
        }
        return { ok: false, message: `Failed to save screenshot: ${err?.message}` };
      }
    }
    if (extraArgs.json) {
      return {
        ok: true,
        message: JSON.stringify({ base64: shot.base64 }),
        data: { base64: shot.base64 },
      };
    }
    return {
      ok: true,
      message: `Screenshot captured (${Math.round(((shot.base64?.length || 0) * 0.75) / 1024)} KB).`,
      data: { base64: shot.base64 },
    };
  }

  if (cmd === 'install') {
    const apkFile = extraArgs.apk || extraArgs.file || name;
    if (!apkFile) {
      if (extraArgs.json) {
        return {
          ok: false,
          message: JSON.stringify({ error: 'APK file path is required for install' }),
          data: { error: 'APK file path is required for install' },
        };
      }
      return { ok: false, message: 'APK file path is required for install' };
    }
    const targetDevice = extraArgs.apk || extraArgs.file ? name : undefined;
    const res = await installApkToDevice(apkFile, targetDevice);
    if (extraArgs.json) {
      return {
        ok: res.ok,
        message: JSON.stringify(
          res.ok ? { success: true, message: res.message } : { error: res.message },
        ),
        data: { success: res.ok, message: res.message },
      };
    }
    return { ok: res.ok, message: res.message };
  }

  if (cmd === 'reverse') {
    const rawPortMapping = extraArgs.ports || extraArgs.port || name;
    if (!rawPortMapping) {
      if (extraArgs.json) {
        return {
          ok: false,
          message: JSON.stringify({
            error: 'Port mapping is required for reverse (e.g. 8080:8080)',
          }),
          data: { error: 'Port mapping is required for reverse (e.g. 8080:8080)' },
        };
      }
      return { ok: false, message: 'Port mapping is required for reverse (e.g. 8080:8080)' };
    }
    const parts = String(rawPortMapping).trim().split(':');
    const remotePort = parseInt(parts[0], 10);
    const localPort = parseInt(parts[1] || parts[0], 10);
    const targetDevice = extraArgs.ports || extraArgs.port ? name : undefined;
    const res = await reverseDevicePort(remotePort, localPort, targetDevice);
    if (extraArgs.json) {
      return {
        ok: res.ok,
        message: JSON.stringify(
          res.ok ? { success: true, message: res.message } : { error: res.message },
        ),
        data: { success: res.ok, message: res.message },
      };
    }
    return { ok: res.ok, message: res.message };
  }

  if (cmd === 'logcat') {
    const lines = extraArgs.lines ? parseInt(String(extraArgs.lines), 10) : 100;
    const filter = extraArgs.filter ? String(extraArgs.filter) : undefined;
    const res = await captureDeviceLogcat(lines, filter, name);
    if (!res.ok) {
      if (extraArgs.json) {
        return {
          ok: false,
          message: JSON.stringify({ error: res.error || 'Failed to read logcat' }),
          data: { error: res.error },
        };
      }
      return { ok: false, message: res.error || 'Failed to read logcat' };
    }
    const logList = res.logs || [];
    if (extraArgs.json) {
      return {
        ok: true,
        message: JSON.stringify({ lines: logList }),
        data: { lines: logList },
      };
    }
    return {
      ok: true,
      message: logList.join('\n') || '(logcat empty)',
      data: { lines: logList },
    };
  }

  if (cmd === 'build') {
    const res = await buildEmulatorImage({
      acceptLicense: Boolean(extraArgs.acceptLicense),
      toolsUrl: extraArgs.toolsUrl,
      toolsSha256: extraArgs.toolsSha256,
    });
    if (extraArgs.json) {
      return {
        ok: res.ok,
        message: JSON.stringify(res.ok ? { image: LOCAL_IMAGE } : { error: res.message }),
        data: { image: LOCAL_IMAGE },
      };
    }
    return { ok: res.ok, message: res.message };
  }

  return { ok: false, message: `Unknown command '${cmd}'` };
}

export async function createDevice(
  name: string,
  options: {
    image?: string;
    port?: number;
    api?: string;
    deviceModel?: string;
    resolution?: DeviceResolution;
  } = {},
): Promise<{ ok: boolean; message: string; profile?: DeviceProfile }> {
  // Validate device name (letters, numbers, underscores, dashes only)
  if (!name || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || name.includes('__proto__')) {
    return {
      ok: false,
      message: 'Invalid device name. Use alphanumeric characters, dots, underscores, or dashes.',
    };
  }

  if (options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)) {
    return { ok: false, message: 'ADB port must be an integer between 1024 and 65535.' };
  }

  const parsedResolution = parseResolution(options.resolution);
  if (!parsedResolution.ok) return { ok: false, message: parsedResolution.error };

  return updateRegistry((registry) => {
    if (registry.devices[name]) {
      return { ok: false, message: `Device '${name}' already exists.` };
    }

    let port = options.port;
    if (port === undefined) {
      // Auto-assign next available high port starting from 5556
      const assignedPorts = new Set(
        Object.values(registry.devices)
          .map((d) => d.port)
          .filter(Boolean),
      );
      let nextPort = 5556;
      while (assignedPorts.has(nextPort) && nextPort < 65535) {
        nextPort += 2;
      }
      port = nextPort;
    }

    // Check for port collision across registered devices
    if (options.port !== undefined) {
      const portInUse = Object.values(registry.devices).find((d) => d.port === port);
      if (portInUse) {
        return {
          ok: false,
          message: `Port ${port} already assigned to device '${portInUse.name}'. Choose another port.`,
        };
      }
    }

    let image = options.image;
    if (!image) {
      if (options.api) {
        const cleanApi = options.api.replace(/^android-?/i, '');
        const version = cleanApi.includes('.') ? cleanApi : `${cleanApi}.0`;
        image = `docker.io/budtmo/docker-android:emulator_${version}`;
      } else {
        image = DEFAULT_IMAGE;
      }
    }

    const profile: DeviceProfile = {
      name,
      type: 'podman',
      port,
      serial: `127.0.0.1:${port}`,
      status: 'stopped',
      image,
      deviceModel: options.deviceModel || process.env.AWRIT_ANDROID_DEVICE_MODEL,
      resolution: parsedResolution.resolution,
      createdAt: Date.now(),
    };

    registry.devices[name] = profile;
    return {
      ok: true,
      message: `Device '${name}' created. Image: ${image}, ADB port: ${port}`,
      profile,
    };
  });
}

export async function startDevice(
  name: string,
  options: { force?: boolean; terminalProgress?: boolean } = {},
): Promise<{ ok: boolean; message: string; serial?: string }> {
  const registry = loadRegistry();
  const dev = registry.devices[name];
  if (!dev) {
    return { ok: false, message: `Device '${name}' not found. Use 'create' first.` };
  }

  // Acquire per-device start lock
  const lockAcq = acquireDeviceLock(name);
  if (!lockAcq.ok || !lockAcq.handle) {
    return { ok: false, message: lockAcq.message || `Could not acquire lock for device '${name}'.` };
  }
  const lockHandle = lockAcq.handle;

  try {
    if (!podmanAvailable()) {
      return { ok: false, message: 'Podman binary not found on PATH.' };
    }

    const adbBin = findBinary('adb');
    const containerName = deviceContainerName(dev.name);
    const hostPort = dev.port || 5556;
    const serial = `127.0.0.1:${hostPort}`;

    let containerExists = false;
    try {
      const container = await inspectContainer(containerName);
      containerExists = container !== null;
      if (container) {
        dev.containerId = container.id;
        dev.status = container.running ? 'running' : 'stopped';
        dev.serial = serial;
      } else {
        dev.status = 'stopped';
        delete dev.containerId;
      }
      await updateRegistry((latest) => {
        const current = latest.devices[name];
        if (!current || current.createdAt !== dev.createdAt) throw new Error(`Device '${name}' changed while starting.`);
        current.status = dev.status;
        current.serial = dev.serial;
        if (dev.containerId) current.containerId = dev.containerId;
        else delete current.containerId;
      });
    } catch (error) {
      return {
        ok: false,
        message: `Could not inspect '${containerName}': ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    if (containerExists && dev.status === 'running') {
      if (options.terminalProgress)
        process.stderr.write(`Waiting for Android ADB at ${serial} (up to 3 minutes)… ${slowBootHint(name)}\n`);
      const ready = await waitForAdb(adbBin, serial);
      return {
        ok: ready,
        message: ready
          ? `Device '${name}' ready at ${serial}`
          : `Container '${containerName}' is running but Android ADB is unavailable. Check: podman logs ${containerName}.`,
        serial,
      };
    }

    const doc = await runDoctor();
    if (doc.freeMemMb < 2048 && !options.force && process.env.AWRIT_FORCE_START !== '1') {
      return {
        ok: false,
        message: `Insufficient memory to start Android device (${doc.freeMemMb} MB free, minimum 2048 MB required). Use --force or free up memory.`,
      };
    }

    const devModel = dev.deviceModel || process.env.AWRIT_ANDROID_DEVICE_MODEL;
    const image = dev.image || DEFAULT_IMAGE;
    const dockerAndroid = isDockerAndroidImage(image);

    if (containerExists && dockerAndroid) {
      try {
        // An abruptly killed SDK emulator can leave a PID lock across container restarts.
        await podmanExec(
          [
            'unshare',
            'sh',
            '-c',
            `
awrit_root=$("$1" mount "$2") || exit 1
trap '"$1" unmount "$2" >/dev/null' EXIT
trap 'exit 1' HUP INT TERM
[ "$("$1" inspect "$2" --format '{{.State.Running}}')" = false ] || exit 1
awrit_root=$(realpath -e -- "$awrit_root") || exit 1
if awrit_avd=$(realpath -e -- "$awrit_root/home/androidusr/emulator" 2>/dev/null); then
  case "$awrit_avd" in "$awrit_root"/*) ;; *) exit 1 ;; esac
  rm -f -- "$awrit_avd/hardware-qemu.ini.lock" "$awrit_avd/multiinstance.lock" "$awrit_avd/snapshot.lock.lock" || exit 1
fi
"$1" unmount "$2" || exit 1
trap - EXIT
`,
            'sh',
            podmanBinary(),
            containerName,
          ],
          10000,
        );
      } catch (error) {
        return {
          ok: false,
          message: `Could not clear the stopped emulator's stale lock: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }

    if (!containerExists && !(await isHostPortFree(hostPort))) {
      return {
        ok: false,
        message: `ADB port ${hostPort} on 127.0.0.1 is already in use. Delete the device and create it again with another port.`,
      };
    }

    const runArgs = [
      'run',
      '-d',
      '--name',
      containerName,
      '--label',
      'awrit.managed=1',
      '--label',
      `awrit.device=${name}`,
      ...(existsSync(KVM_DEVICE) ? ['--device', KVM_DEVICE] : []),
      '-p',
      `127.0.0.1:${hostPort}:5555`,
      ...(devModel ? ['-e', `DEVICE=${devModel}`] : []),
      ...(dockerAndroid
        ? ['--user', 'root', '-e', 'EMULATOR_HEADLESS=true', '-e', 'EMULATOR_ADDITIONAL_ARGS=-no-window']
        : []),
      ...(dev.resolution
        ? [
            '-e',
            `SCREEN_WIDTH=${dev.resolution.width}`,
            '-e',
            `SCREEN_HEIGHT=${dev.resolution.height}`,
            ...(dev.resolution.density ? ['-e', `SCREEN_DPI=${dev.resolution.density}`] : []),
          ]
        : []),
      // Fall back to clean authfile if host ~/.docker/config.json has expired credentials
      '--authfile',
      ensureContainerAuthFile(),
      image,
      ...(dockerAndroid ? [ROOTLESS_ANDROID_START] : []),
    ];

    const logFile = getDeviceLogPath(name);

    if (options.terminalProgress) {
      process.stderr.write(
        [
          containerExists
            ? `Resuming '${name}'…`
            : `Starting '${name}' — downloading the image if needed…`,
          `  Image: ${image}`,
          ...(image.startsWith('docker.io/budtmo/docker-android:') ||
          image.startsWith('docker.io/budtmo/docker-android@')
            ? ['  Source: https://hub.docker.com/r/budtmo/docker-android']
            : []),
          `  ADB: ${serial}`,
          ...(devModel ? [`  Device: ${devModel}`] : []),
          `  Log: ${logFile}`,
          '',
        ].join('\n'),
      );
    }

    let result: Awaited<ReturnType<typeof runPodman>>;
    try {
      // Let Podman render its native download bars when stderr is a terminal.
      result = await runPodman(containerExists ? ['start', containerName] : runArgs, {
        inheritStderr: Boolean(options.terminalProgress),
        onStdout: (chunk) => {
          try {
            appendFileSync(logFile, chunk, 'utf8');
          } catch (_e) {}
        },
        onStderr: (chunk) => {
          try {
            appendFileSync(logFile, chunk, 'utf8');
          } catch (_e) {}
        },
      });
    } catch (error) {
      if (!containerExists) {
        // A failed `podman run` can leave a half-created container behind.
        await removeContainer(containerName);
      }
      if (error instanceof PodmanFailure) {
        const detail =
          error.result.stderr || error.result.stdout || `exit code ${error.result.code}`;
        return {
          ok: false,
          message: `Failed to start container with Podman: ${detail}. Logs written to ${logFile}`,
        };
      }
      return {
        ok: false,
        message: `Podman execution error: ${error instanceof Error ? error.message : String(error)}. Logs: ${logFile}`,
      };
    }

    if (!containerExists) dev.containerId = result.stdout.trim().substring(0, 12);
    dev.status = 'running';
    dev.serial = serial;
    try {
      await updateRegistry((latest) => {
        const current = latest.devices[name];
        if (!current || current.createdAt !== dev.createdAt) throw new Error(`Device '${name}' changed while starting.`);
        current.status = dev.status;
        current.serial = dev.serial;
        current.containerId = dev.containerId;
      });
    } catch (error) {
      return { ok: false, message: `Container started but registry update failed: ${String(error)}` };
    }

    if (options.terminalProgress)
      process.stderr.write(`Waiting for Android ADB at ${serial} (up to 3 minutes)… ${slowBootHint(name)}\n`);
    const ready = await waitForAdb(adbBin, serial);
    return {
      ok: ready,
      message: ready
        ? `'${name}' ready at ${serial}. Logs: ${logFile}`
        : `Container '${containerName}' started, but Android ADB did not become ready within 3 minutes. ${slowBootHint(name)} Check: podman logs ${containerName}. Retry with 'start ${name}' after resolving the boot failure.`,
      serial,
    };
  } finally {
    lockHandle.release();
  }
}
