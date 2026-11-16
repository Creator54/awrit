import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { findBinary } from './adbControl';

const executeFile = promisify(execFile);

const PODMAN_FALLBACKS = [
  '/run/current-system/sw/bin/podman',
  '/usr/bin/podman',
  '/usr/local/bin/podman',
];

/** Podman failures a caller can react to differently from a generic exit code. */
export class PodmanError extends Error {}

export class PodmanMissingError extends PodmanError {
  constructor(message = 'Podman binary not found on PATH.') {
    super(message);
    this.name = 'PodmanMissingError';
  }
}

export interface PodmanResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class PodmanFailure extends PodmanError {
  constructor(
    message: string,
    readonly result: PodmanResult,
  ) {
    super(message);
    this.name = 'PodmanFailure';
  }
}

export class KvmMissingError extends PodmanFailure {
  constructor(result: PodmanResult) {
    super('Podman could not use /dev/kvm.', result);
    this.name = 'KvmMissingError';
  }
}

export class ImagePullFailedError extends PodmanFailure {
  constructor(result: PodmanResult) {
    super('Podman could not pull the image.', result);
    this.name = 'ImagePullFailedError';
  }
}

export function podmanBinary(): string {
  return findBinary('podman', PODMAN_FALLBACKS);
}

export function podmanAvailable(): boolean {
  return existsSync(podmanBinary());
}

function requireBinary(): string {
  const bin = podmanBinary();
  if (!existsSync(bin)) throw new PodmanMissingError();
  return bin;
}

/** Resolves the reported version, or undefined when the binary is missing or unusable. */
export async function podmanVersion(): Promise<string | undefined> {
  const bin = podmanBinary();
  if (!existsSync(bin)) return undefined;
  return new Promise((resolve) => {
    let out = '';
    const proc = spawn(bin, ['--version']);
    proc.stdout.on('data', (d) => {
      out += d.toString();
    });
    proc.on('close', () => resolve(proc.exitCode === 0 ? out.trim() : undefined));
    proc.on('error', () => resolve(undefined));
  });
}

export interface ContainerState {
  id: string;
  running: boolean;
}

/** Null means the container does not exist; storage and permission failures throw. */
export async function inspectContainer(name: string): Promise<ContainerState | null> {
  const bin = requireBinary();
  try {
    await executeFile(bin, ['container', 'exists', name], { timeout: 5000 });
  } catch (error) {
    // Podman reports absence with 1; storage and permission failures must stay visible.
    if (error instanceof Error && 'code' in error && error.code === 1) return null;
    throw error;
  }
  const { stdout } = await executeFile(
    bin,
    ['inspect', name, '--format', '{{.Id}} {{.State.Running}}'],
    { timeout: 5000 },
  );
  const match = /^([a-f0-9]{64}) (true|false)$/.exec(stdout.trim());
  if (!match) throw new Error('Invalid container inspection response');
  return { id: match[1].substring(0, 12), running: match[2] === 'true' };
}

export interface ContainerSummary {
  name: string;
  id: string;
  running: boolean;
  /** Carries the `awrit.managed=1` label. Containers created before labelling lack it. */
  managed: boolean;
}

/** `podman ps -a` reduced to the fields Awrit reads, one entry per container. */
export async function listContainers(): Promise<ContainerSummary[]> {
  const bin = requireBinary();
  const args = [
    'ps',
    '-a',
    '--format',
    '{{.Names}}|{{.ID}}|{{.State}}|{{index .Labels "awrit.managed"}}',
  ];
  const { stdout } = await executeFile(bin, args, { timeout: 10000 });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [name, id, state, managed] = line.split('|');
      if (!name || !id || !state) return [];
      return [{ name, id, running: state === 'running', managed: managed === '1' }];
    });
}

export interface PodmanRunOptions {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  /** Let Podman draw its native progress bars on the caller's stderr. */
  inheritStderr?: boolean;
}

function classifyFailure(result: PodmanResult): PodmanFailure {
  if (/\/dev\/kvm/.test(result.stderr)) return new KvmMissingError(result);
  if (
    /error pulling image|manifest unknown|short-name|no such image|unable to pull|failed to resolve image/i.test(
      result.stderr,
    )
  ) {
    return new ImagePullFailedError(result);
  }
  return new PodmanFailure(`podman ${result.code}`, result);
}

/**
 * Runs any Podman subcommand and collects its output. A non-zero exit throws a typed
 * PodmanFailure so callers can pick a specific message without parsing stderr again.
 */
export async function runPodman(
  args: string[],
  options: PodmanRunOptions = {},
): Promise<PodmanResult> {
  const bin = requireBinary();
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      stdio: ['ignore', 'pipe', options.inheritStderr ? 'inherit' : 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    proc.stdout?.on('data', (d) => {
      const chunk = d.toString();
      stdout += chunk;
      options.onStdout?.(chunk);
    });
    proc.stderr?.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      const result: PodmanResult = { code: code ?? 1, stdout, stderr };
      if (result.code === 0) resolve(result);
      else reject(classifyFailure(result));
    });
  });
}

/** Runs a Podman subcommand that must finish within the timeout. */
export async function podmanExec(args: string[], timeoutMs: number): Promise<string> {
  const bin = requireBinary();
  const { stdout } = await executeFile(bin, args, { timeout: timeoutMs });
  return stdout;
}

/** True when the container stopped, false when it was not stopped or Podman is unavailable. */
export async function stopContainer(name: string): Promise<boolean> {
  if (!podmanAvailable()) return false;
  return new Promise((resolve) => {
    const proc = spawn(podmanBinary(), ['stop', name]);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/** True when the removal succeeded; a missing container counts as removed. */
export async function removeContainer(name: string, force = true): Promise<boolean> {
  if (!podmanAvailable()) return false;
  return new Promise((resolve) => {
    const proc = spawn(podmanBinary(), ['rm', ...(force ? ['-f'] : []), name]);
    proc.on('close', (code) => resolve(code === 0));
    proc.on('error', () => resolve(false));
  });
}

/** Streams build output to stderr, like the manual command users would run. */
export async function buildImage(args: string[]): Promise<number> {
  const bin = requireBinary();
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['build', ...args], { stdio: ['ignore', 2, 2] });
    proc.on('error', reject);
    proc.on('close', (code) => resolve(code ?? 1));
  });
}
