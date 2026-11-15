/**
 * Local entry for `awrit show <url> --host <alias>`: finds a usable runtime on
 * the host, asking before it installs one. Without --remote-awrit this probes
 * the host over ssh; the install itself is planned and run in ./install.
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Readable } from 'node:stream';
import {
  type HostScriptResult,
  installPlan,
  installRuntime,
  PROBE_SCRIPT,
  type ProbeResult,
  parseProbe,
} from './install';
import { readPackagedSource } from './packagedSource';
import { sshCommandArgv, sshScriptArgv, validateRuntimePath } from './sshCommand';
import { relayRemoteStderr } from './stderr';

const PROBE_TIMEOUT_MS = 30_000;
/** How far to walk up from this module; enough for src/remote and the built dist. */
const MAX_DEPTH = 5;

function findUp(name: string): string | undefined {
  let dir = __dirname;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/** The version this Awrit would install; the same string the local package has. */
function localVersion(): string {
  const file = findUp('package.json');
  if (!file) throw new Error('cannot find the Awrit package.json next to this program');
  const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
  const version = (parsed as { version?: unknown }).version;
  if (typeof version !== 'string') throw new Error('the Awrit package.json has no version');
  return version;
}

/** The checkout this Awrit can build from; a built package has no flake.nix. */
function sourceRoot(): string | undefined {
  const flake = findUp('flake.nix');
  if (!flake) return undefined;
  const root = dirname(flake);
  return existsSync(join(root, '.git')) ? root : undefined;
}

function readAll(child: { stdout?: Readable | null }): () => string {
  const chunks: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString('utf8');
}

/** Runs one fixed sh script through `sh -s`; stderr is terminal-safe. */
function runScript(alias: string, script: string, args: string[] = []): Promise<HostScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshScriptArgv(alias, args), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    relayRemoteStderr(child.stderr);
    const stdout = readAll(child);
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? 1, stdout: stdout() }));
    // ssh can exit before it reads the script; the close code is what matters.
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(script);
  });
}

/** One ssh connection that runs a fixed command with `input` on its stdin. */
function runInput(alias: string, argv: string[], input: Readable): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshCommandArgv(alias, argv), {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    relayRemoteStderr(child.stderr);
    // tee stages the archive; never retain its echoed binary stdout.
    child.stdout?.resume();
    child.once('error', reject);
    child.once('close', (code) => resolve(code ?? 1));
    const stdin = child.stdin;
    if (!stdin) {
      reject(new Error('ssh did not provide a stdin pipe'));
      return;
    }
    stdin.on('error', () => undefined);
    // Bun's Readable.pipe into a child stdin dropped the tail of the archive;
    // the source is a few MB, so collect it and write it in one call.
    const chunks: Buffer[] = [];
    input.on('data', (chunk: Buffer) => chunks.push(chunk));
    input.once('error', (error) => {
      child.kill();
      reject(error);
    });
    input.once('end', () => stdin.end(Buffer.concat(chunks)));
  });
}

function git(root: string, args: string[]): Buffer {
  const result = spawnSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

/**
 * The runtime name for a checkout: the package version plus the commit, so a
 * host never mistakes another commit's build for this one.
 */
function checkoutVersion(root: string, version: string): string {
  const commit = git(root, ['rev-parse', '--short=12', 'HEAD']).toString().trim();
  return `${version}-g${commit}`;
}

/**
 * The tracked source at HEAD. Read whole before sending: it is a few MB, and
 * a failed archive must stop the install rather than upload a short file.
 */
function archive(root: string): Readable {
  if (git(root, ['status', '--porcelain', '--untracked-files=no']).length > 0) {
    process.stderr.write('Uncommitted changes are not sent; the host builds the last commit.\n');
  }
  return Readable.from([git(root, ['archive', 'HEAD'])]);
}

function probeHost(alias: string): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshScriptArgv(alias), { stdio: ['pipe', 'pipe', 'pipe'] });
    relayRemoteStderr(child.stderr);
    const stdout = readAll(child);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${alias}: the ssh probe timed out after ${PROBE_TIMEOUT_MS / 1000} s`));
    }, PROBE_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0) throw new Error(`${alias}: the ssh probe exited with code ${code}`);
        resolve(parseProbe(stdout()));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(PROBE_SCRIPT);
  });
}

export async function askYes(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // question() never settles if input ends or Ctrl-C closes the interface.
  const closed = new Promise<string>((resolve) => rl.once('close', () => resolve('')));
  rl.once('SIGINT', () => rl.close());
  try {
    const answer = (await Promise.race([rl.question(question), closed])).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

/**
 * Absolute launcher path on the host, or undefined when the host cannot run it
 * or the user declined the install (both print why and leave exit code 1).
 */
export async function resolveRemoteRuntime(
  alias: string,
  explicit?: string,
): Promise<string | undefined> {
  if (explicit !== undefined) return validateRuntimePath(explicit);

  const probe = await probeHost(alias);
  const launcher = process.env.AWRIT_LAUNCHER;
  const installedSource = launcher
    ? join(dirname(launcher), '../lib/awrit/remote-install')
    : undefined;
  const packagedDirectory =
    installedSource && existsSync(installedSource) ? installedSource : undefined;
  const root = packagedDirectory ? undefined : sourceRoot();
  const packaged = packagedDirectory ? readPackagedSource(packagedDirectory) : undefined;
  const version = root
    ? checkoutVersion(root, localVersion())
    : (packaged?.version ?? localVersion());
  const plan = installPlan(probe, { version });
  for (const reason of plan.reasons) process.stderr.write(`${alias}: ${reason}\n`);
  if (plan.action === 'unsupported') return undefined;
  if (plan.action === 'none') return `${probe.runtimeDir}/${version}/bin/awrit`;

  if (!root && !packaged) {
    throw new Error(
      'Installing the Awrit runtime needs its bundled source manifest or an Awrit source checkout. Pass --remote-awrit <path of awrit on the host> to use a runtime that is already there.',
    );
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      'Installing the Awrit runtime needs an interactive terminal. Pass --remote-awrit <path of awrit on the host> to use a runtime that is already there.',
    );
  }

  process.stdout.write(`${plan.consentText}\n`);
  return installRuntime({
    version,
    runtimeDir: probe.runtimeDir,
    runScript: (script, args) => runScript(alias, script, args),
    runInput: (argv, input) => runInput(alias, argv, input),
    archive: () => {
      if (!root) throw new Error('No checkout source is available');
      return archive(root);
    },
    packagedSource: packaged?.bytes,
    ask: askYes,
    say: (line) => process.stderr.write(`${line}\n`),
  });
}
