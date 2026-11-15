import { describe, expect, test } from 'bun:test';
import { selectManagedRuntime } from './runtimeSelection';

describe('selectManagedRuntime', () => {
  test('Linux x86_64 with ready KVM and all dependencies returns kvm ready', () => {
    const res = selectManagedRuntime({
      platform: 'linux',
      hostArch: 'x86_64',
      kvmStatus: 'ready',
      podman: true,
      adb: true,
      ffmpeg: true,
    });
    expect(res.status).toBe('ready');
    expect(res.runtime).toBe('kvm');
    expect(res.reason).toContain('KVM acceleration');
  });

  test('Linux x64 normalized to x86_64 with ready KVM and all dependencies returns kvm ready', () => {
    const res = selectManagedRuntime({
      platform: 'linux',
      hostArch: 'x64',
      kvmStatus: 'ready',
      podman: true,
      adb: true,
      ffmpeg: true,
    });
    expect(res.status).toBe('ready');
    expect(res.runtime).toBe('kvm');
  });

  test('Linux x86_64 with missing dependencies returns unsupported with missing names', () => {
    const res = selectManagedRuntime({
      platform: 'linux',
      hostArch: 'x86_64',
      kvmStatus: 'ready',
      podman: false,
      adb: true,
      ffmpeg: false,
    });
    expect(res.status).toBe('unsupported');
    expect(res.runtime).toBeNull();
    expect(res.reason).toContain('podman');
    expect(res.reason).toContain('ffmpeg');
    expect(res.reason).not.toContain('adb');
  });

  test('Linux x86_64 with missing KVM returns setup-required Redroid if dependencies exist', () => {
    const res = selectManagedRuntime({
      platform: 'linux',
      hostArch: 'x86_64',
      kvmStatus: 'missing',
      podman: true,
      adb: true,
      ffmpeg: true,
    });
    expect(res.status).toBe('setup-required');
    expect(res.runtime).toBe('redroid');
    expect(res.reason).toMatch(/kernel|privilege|approval/i);
  });

  test('Linux x86_64 with permission-denied KVM returns setup-required Redroid if dependencies exist', () => {
    const res = selectManagedRuntime({
      platform: 'linux',
      hostArch: 'x86_64',
      kvmStatus: 'permission-denied',
      podman: true,
      adb: true,
      ffmpeg: true,
    });
    expect(res.status).toBe('setup-required');
    expect(res.runtime).toBe('redroid');
    expect(res.reason).toMatch(/kernel|privilege|approval/i);
  });

  test('Linux arm64 with ready KVM is NOT ready KVM (do not prefer unverified ARM KVM with current x86 image) and returns Redroid setup-required if deps exist', () => {
    const res = selectManagedRuntime({
      platform: 'linux',
      hostArch: 'arm64',
      kvmStatus: 'ready',
      podman: true,
      adb: true,
      ffmpeg: true,
    });
    expect(res.status).toBe('setup-required');
    expect(res.runtime).toBe('redroid');
    expect(res.reason).toMatch(/kernel|privilege|approval/i);
  });

  test('Linux aarch64 normalized to arm64 returns Redroid setup-required if deps exist', () => {
    const res = selectManagedRuntime({
      platform: 'linux',
      hostArch: 'aarch64',
      kvmStatus: 'missing',
      podman: true,
      adb: true,
      ffmpeg: true,
    });
    expect(res.status).toBe('setup-required');
    expect(res.runtime).toBe('redroid');
  });

  test('Linux arm64 with missing dependencies returns unsupported with missing names', () => {
    const res = selectManagedRuntime({
      platform: 'linux',
      hostArch: 'arm64',
      kvmStatus: 'ready',
      podman: false,
      adb: false,
      ffmpeg: true,
    });
    expect(res.status).toBe('unsupported');
    expect(res.runtime).toBeNull();
    expect(res.reason).toContain('podman');
    expect(res.reason).toContain('adb');
  });

  test('non-Linux OS returns unsupported', () => {
    const darwin = selectManagedRuntime({
      platform: 'darwin',
      hostArch: 'x86_64',
      kvmStatus: 'ready',
      podman: true,
      adb: true,
      ffmpeg: true,
    });
    expect(darwin.status).toBe('unsupported');
    expect(darwin.runtime).toBeNull();
    expect(darwin.reason).toContain('darwin');

    const win = selectManagedRuntime({
      platform: 'win32',
      hostArch: 'x86_64',
      kvmStatus: 'ready',
      podman: true,
      adb: true,
      ffmpeg: true,
    });
    expect(win.status).toBe('unsupported');
    expect(win.runtime).toBeNull();
  });

  test('unsupported architecture returns unsupported', () => {
    const s390x = selectManagedRuntime({
      platform: 'linux',
      hostArch: 's390x',
      kvmStatus: 'ready',
      podman: true,
      adb: true,
      ffmpeg: true,
    });
    expect(s390x.status).toBe('unsupported');
    expect(s390x.runtime).toBeNull();
    expect(s390x.reason).toContain('s390x');
  });
});
