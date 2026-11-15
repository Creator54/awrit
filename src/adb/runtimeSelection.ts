export type KvmStatus = 'ready' | 'missing' | 'permission-denied';

export type ManagedRuntimeDecision =
  | { status: 'ready'; runtime: 'kvm'; reason: string }
  | { status: 'setup-required'; runtime: 'redroid'; reason: string }
  | { status: 'unsupported'; runtime: null; reason: string };

export interface RuntimeSelectionInput {
  platform: string;
  hostArch: string;
  kvmStatus: KvmStatus;
  podman: boolean;
  adb: boolean;
  ffmpeg: boolean;
}

function normalizeArch(arch: string): string {
  if (arch === 'x64') return 'x86_64';
  if (arch === 'ia32') return 'x86';
  if (arch === 'aarch64') return 'arm64';
  return arch;
}

export function selectManagedRuntime(input: RuntimeSelectionInput): ManagedRuntimeDecision {
  const missingDeps: string[] = [];
  if (!input.podman) missingDeps.push('podman');
  if (!input.adb) missingDeps.push('adb');
  if (!input.ffmpeg) missingDeps.push('ffmpeg');

  if (input.platform !== 'linux') {
    return {
      status: 'unsupported',
      runtime: null,
      reason: `Platform '${input.platform}' is unsupported for managed Android runtime (Linux required)`,
    };
  }

  const arch = normalizeArch(input.hostArch);

  if (missingDeps.length > 0) {
    return {
      status: 'unsupported',
      runtime: null,
      reason: `Missing required dependencies: ${missingDeps.join(', ')}`,
    };
  }

  if (arch === 'x86_64') {
    if (input.kvmStatus === 'ready') {
      return {
        status: 'ready',
        runtime: 'kvm',
        reason: 'x86_64 Linux host with hardware KVM acceleration ready',
      };
    }
    // KVM missing or permission-denied -> Redroid candidate
    return {
      status: 'setup-required',
      runtime: 'redroid',
      reason:
        'Redroid container candidate requires manual kernel module, container privilege validation, and user approval; not runnable automatically',
    };
  }

  if (arch === 'arm64') {
    // Current emulator image is x86_64 only; unverified ARM KVM cannot be used.
    // Redroid is candidate if dependencies exist.
    return {
      status: 'setup-required',
      runtime: 'redroid',
      reason:
        'ARM64 Linux host requires Redroid setup; kernel module, container privilege validation, and user approval required; not runnable automatically',
    };
  }

  return {
    status: 'unsupported',
    runtime: null,
    reason: `Architecture '${input.hostArch}' is unsupported for managed Android runtime`,
  };
}
