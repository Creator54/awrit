/**
 * Read-only capability probe, install plan and the consent install for a
 * remote Awrit host.
 *
 * Every remote step is a fixed POSIX script sent through `sh -s` (or a fixed argv
 * command with validated arguments), so it works when the login shell is fish or
 * csh. Nothing is interpolated into a script and the probe writes nothing.
 */

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { validateRuntimePath } from './sshCommand';

export type ProbeArch = 'x86_64' | 'aarch64' | 'unsupported';

export type ProbeResult = {
  os: string;
  arch: ProbeArch;
  kernel: string;
  cpus: number;
  memMiB: number;
  diskFreeMiB: number;
  xdgRuntime: boolean;
  userns: boolean;
  kvm: boolean;
  tools: {
    nix: boolean;
    node: boolean;
    ffmpeg: boolean;
    podman: boolean;
    adb: boolean;
  };
  /** Absolute runtime directory on the host, e.g. /home/you/.local/share/awrit/runtime. */
  runtimeDir: string;
  runtimes: string[];
};

export type InstallAction = 'none' | 'install' | 'unsupported';

export type InstallPlan = {
  action: InstallAction;
  reasons: string[];
  consentText?: string;
};

export const PROBE_MARKER = 'AWRIT-PROBE-1';
const PROBE_END = 'AWRIT-PROBE-END';

const RUNTIME_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOOL_KEYS = ['nix', 'node', 'ffmpeg', 'podman', 'adb'] as const;
const KNOWN_KEYS = new Set([
  'os',
  'arch',
  'kernel',
  'cpus',
  'memMiB',
  'diskFreeMiB',
  'xdgRuntime',
  'userns',
  'kvm',
  'runtimeDir',
]);

/**
 * Fixed POSIX sh probe. Nothing is interpolated into it and it writes nothing.
 * Lines are only printed after the values come from fixed commands or the
 * runtime directory listing, whose names are filtered before printing.
 */
export const PROBE_SCRIPT = `# Awrit remote capability probe. Fixed POSIX sh, read-only.
printf 'AWRIT-PROBE-1\\n'

printf 'os=%s\\n' "$(uname -s 2>/dev/null || printf unknown)"
printf 'arch=%s\\n' "$(uname -m 2>/dev/null || printf unknown)"
printf 'kernel=%s\\n' "$(uname -r 2>/dev/null || printf unknown)"

cpus=$(nproc 2>/dev/null)
if [ -z "$cpus" ]; then cpus=$(getconf _NPROCESSORS_ONLN 2>/dev/null); fi
case "$cpus" in ''|*[!0-9]*) cpus=1 ;; esac
printf 'cpus=%s\\n' "$cpus"

mem_kb=$(awk '/^MemTotal:/ { print $2 }' /proc/meminfo 2>/dev/null)
if [ -z "$mem_kb" ] && command -v sysctl >/dev/null 2>&1; then
  mem_bytes=$(sysctl -n hw.memsize 2>/dev/null)
  case "$mem_bytes" in ''|*[!0-9]*) mem_bytes=0 ;; esac
  mem_kb=$((mem_bytes / 1024))
fi
case "$mem_kb" in ''|*[!0-9]*) mem_kb=0 ;; esac
printf 'memMiB=%s\\n' "$((mem_kb / 1024))"

disk_kb=$(df -Pk "$HOME" 2>/dev/null | awk 'NR == 2 { print $4 }')
case "$disk_kb" in ''|*[!0-9]*) disk_kb=0 ;; esac
printf 'diskFreeMiB=%s\\n' "$((disk_kb / 1024))"

xdg_runtime=false
if [ -n "\${XDG_RUNTIME_DIR:-}" ] && [ -d "\${XDG_RUNTIME_DIR}" ]; then xdg_runtime=true; fi
printf 'xdgRuntime=%s\\n' "$xdg_runtime"

userns=false
if unshare --user --map-root-user true >/dev/null 2>&1; then userns=true; fi
printf 'userns=%s\\n' "$userns"

kvm=false
if [ -r /dev/kvm ] && [ -w /dev/kvm ]; then kvm=true; fi
printf 'kvm=%s\\n' "$kvm"

for tool in nix node ffmpeg podman adb; do
  found=false
  if command -v "$tool" >/dev/null 2>&1; then found=true; fi
  printf '%s=%s\\n' "$tool" "$found"
done

runtime_dir="\${XDG_DATA_HOME:-$HOME/.local/share}/awrit/runtime"
# The path becomes argv on this host later, so print it only when it is absolute
# and shell-inert; anything else is refused by the local side.
case "$runtime_dir" in
  /*) case "$runtime_dir" in *[!A-Za-z0-9._/@+-]*) runtime_dir="" ;; esac ;;
  *) runtime_dir="" ;;
esac
if [ -n "$runtime_dir" ]; then printf 'runtimeDir=%s\n' "$runtime_dir"; fi
if [ -n "$runtime_dir" ] && [ -d "$runtime_dir" ]; then
  for entry in "$runtime_dir"/*; do
    [ -e "$entry" ] || continue
    name=\${entry##*/}
    case "$name" in [A-Za-z0-9]*) ;; *) continue ;; esac
    case "$name" in ''|*[!A-Za-z0-9._-]*) continue ;; esac
    if [ \${#name} -le 64 ]; then printf 'runtime=%s\\n' "$name"; fi
  done
fi

printf 'AWRIT-PROBE-END\\n'
`;

function normalizeArch(raw: string): ProbeArch {
  switch (raw) {
    case 'x86_64':
    case 'amd64':
      return 'x86_64';
    case 'aarch64':
    case 'arm64':
      return 'aarch64';
    default:
      return 'unsupported';
  }
}

function parseNumber(key: string, value: string): number {
  if (!/^\d{1,15}$/.test(value)) {
    throw new Error(`probe value for ${key} is not a number`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`probe value for ${key} is out of range`);
  }
  return parsed;
}

function parseBoolean(key: string, value: string): boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`probe value for ${key} is not true or false`);
}

function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    // C1 controls include U+009B, which some terminals read as an escape sequence.
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

function assertText(key: string, value: string): string {
  // Control characters would let a remote banner or filename break the line format.
  if (value === '' || value.length > 256 || hasControl(value)) {
    throw new Error(`probe value for ${key} is not plain text`);
  }
  return value;
}

export function parseProbe(stdout: string): ProbeResult {
  const lines = stdout.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const start = lines.indexOf(PROBE_MARKER);
  if (start === -1) {
    throw new Error('probe output is missing the AWRIT-PROBE-1 marker');
  }

  const values = new Map<string, string>();
  const runtimes: string[] = [];
  let ended = false;

  for (let index = start + 1; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined) break;

    if (ended) {
      if (line !== '') {
        throw new Error('probe output has data after AWRIT-PROBE-END');
      }
      continue;
    }

    if (line === PROBE_END) {
      ended = true;
      continue;
    }
    if (line === '') {
      // stdout normally ends with one newline, which is not a real blank line.
      if (index === lines.length - 1) continue;
      throw new Error('probe output has an unexpected blank line');
    }
    if (hasControl(line)) {
      throw new Error('probe output contains control characters');
    }

    const separator = line.indexOf('=');
    if (separator <= 0) {
      throw new Error(`probe output has an unexpected line: ${line.slice(0, 80)}`);
    }
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);

    if (key === 'runtime') {
      if (!RUNTIME_NAME.test(value)) {
        throw new Error('probe output has an invalid runtime name');
      }
      if (runtimes.includes(value)) {
        throw new Error(`probe output has a duplicate runtime ${value}`);
      }
      runtimes.push(value);
      continue;
    }
    if (!(TOOL_KEYS as readonly string[]).includes(key) && !KNOWN_KEYS.has(key)) {
      throw new Error(`probe output has an unexpected probe key: ${key}`);
    }
    if (values.has(key)) {
      throw new Error(`probe output has a duplicate probe key: ${key}`);
    }
    values.set(key, value);
  }

  if (!ended) {
    throw new Error('probe output is missing the AWRIT-PROBE-END marker');
  }

  const required = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) {
      throw new Error(`probe output is missing ${key}`);
    }
    return value;
  };
  const tools = Object.fromEntries(
    TOOL_KEYS.map((key) => [key, parseBoolean(key, required(key))]),
  ) as ProbeResult['tools'];
  let runtimeDir: string;
  try {
    runtimeDir = validateRuntimePath(required('runtimeDir'));
  } catch {
    throw new Error('probe value for runtimeDir is not a safe absolute path');
  }

  return {
    os: assertText('os', required('os')),
    arch: normalizeArch(assertText('arch', required('arch'))),
    kernel: assertText('kernel', required('kernel')),
    cpus: parseNumber('cpus', required('cpus')),
    memMiB: parseNumber('memMiB', required('memMiB')),
    diskFreeMiB: parseNumber('diskFreeMiB', required('diskFreeMiB')),
    xdgRuntime: parseBoolean('xdgRuntime', required('xdgRuntime')),
    userns: parseBoolean('userns', required('userns')),
    kvm: parseBoolean('kvm', required('kvm')),
    tools,
    runtimeDir,
    runtimes,
  };
}

const VERSION = RUNTIME_NAME;
/** Measured size of one built runtime closure, for the consent text only. */
export const RUNTIME_SIZE_MIB = 3072;

export function installPlan(probe: ProbeResult, local: { version: string }): InstallPlan {
  // The version becomes a path on the remote host, so reject anything that could escape it,
  // including '.' and '..' and names that start with a dot.
  if (!VERSION.test(local.version)) {
    throw new Error(`invalid runtime version: ${local.version.slice(0, 80)}`);
  }

  const blockers: string[] = [];
  if (probe.os !== 'Linux') {
    blockers.push(`the Awrit remote runtime runs on Linux only; this host reports ${probe.os}`);
  }
  if (probe.arch === 'unsupported') {
    blockers.push('this host has an unsupported CPU architecture (expected x86_64 or aarch64)');
  }
  if (!probe.userns) {
    blockers.push(
      'user namespaces are unavailable, and the Chromium sandbox needs them; Awrit will not run without the sandbox',
    );
  }

  const notes: string[] = [];
  if (!probe.kvm) {
    notes.push(
      'Android emulators will be unavailable: /dev/kvm is missing or not readable and writable',
    );
  }

  if (blockers.length > 0) {
    return { action: 'unsupported', reasons: [...blockers, ...notes] };
  }

  if (probe.runtimes.includes(local.version)) {
    return { action: 'none', reasons: [`runtime ${local.version} is already installed`, ...notes] };
  }
  // Only the install needs nix; a runtime that is already there runs without it.
  if (!probe.tools.nix) {
    return {
      action: 'unsupported',
      reasons: [
        'nix is not installed on this host; Awrit builds its runtime from source on this host, and that needs nix',
        ...notes,
      ],
    };
  }

  const sizeGiB = Math.round((RUNTIME_SIZE_MIB / 1024) * 10) / 10;
  return {
    action: 'install',
    reasons: notes,
    consentText: [
      `Install the Awrit remote runtime ${local.version} for your user only.`,
      `Destination: ${probe.runtimeDir}/${local.version} on this host, a symlink into the Nix store.`,
      `Route: nix builds the runtime on this host from this Awrit's source, sent over SSH. Nix fetches its own dependencies, so the build can take several minutes.`,
      `Disk: about ${sizeGiB} GiB after the build. Runtime versions are shared by the Nix store, and versions already installed are never touched.`,
      'No sudo, no system service, no changes outside those directories.',
    ].join('\n'),
  };
}

/** One remote step: fixed argv, or a script for `sh -s` plus its positional args. */
export interface HostScriptResult {
  code: number;
  stdout: string;
}

export interface InstallDeps {
  version: string;
  /** Absolute runtime directory reported by the probe. */
  runtimeDir: string;
  /** Runs a fixed sh script through `sh -s` on the host. */
  runScript: (script: string, args?: string[]) => Promise<HostScriptResult>;
  /** Runs a fixed command on the host and pipes `input` to its stdin. */
  runInput: (argv: string[], input: Readable) => Promise<number>;
  /** `git archive HEAD` of the local Awrit source. */
  archive: () => Readable;
  /** Locally verified package bytes; these exact bytes are checked before extraction. */
  packagedSource?: Buffer;
  ask: (question: string) => Promise<boolean>;
  say: (line: string) => void;
}

export const SOURCE_MARKER = 'AWRIT-SRC-1';
const SOURCE_END = 'AWRIT-SRC-END';

/**
 * Fixed POSIX sh that makes one empty staging directory and prints its path.
 * Kept separate from the build because the source archive needs this command's
 * stdin, and `sh -s` already reads the script from stdin.
 */
export const SOURCE_DIR_SCRIPT = `# Awrit remote source staging. Fixed POSIX sh.
set -eu
cache="\${XDG_CACHE_HOME:-$HOME/.cache}/awrit"
mkdir -p "$cache"
src=$(mktemp -d "$cache/src.XXXXXX")
(umask 077; : > "$src/source.tar")
printf 'AWRIT-SRC-1\\nsrc=%s\\nAWRIT-SRC-END\\n' "$src"
`;

/**
 * Fixed POSIX sh that builds the runtime from the staging directory.
 * $1 is the version and $2 the staging directory; both are validated before
 * they are passed, and neither is interpolated into this script.
 * The partial link proves the build before the final link keeps it as a GC root.
 */
export const BUILD_SCRIPT = `# Awrit runtime build on the host. Fixed POSIX sh.
set -eu
version=$1
src=$2
cleanup=\${3:-$src}
runtime="\${XDG_DATA_HOME:-$HOME/.local/share}/awrit/runtime"
mkdir -p "$runtime"
trap 'rm -rf "$cleanup"; rm -f "$runtime/$version.partial"' EXIT

printf 'Building the Awrit %s runtime on this host with nix.\n' "$version" >&2
nix build --out-link "$runtime/$version.partial" "path:$src"

printf 'Checking the built launcher.\n' >&2
"$runtime/$version.partial/bin/awrit" --version >&2

nix build --out-link "$runtime/$version" "path:$src"
rm -f "$runtime/$version.partial"
printf 'Installed Awrit %s at %s/%s.\n' "$version" "$runtime" "$version" >&2
`;

export const VERIFY_SOURCE_SCRIPT = `# Verify before extraction or execution.
set -eu
src=$1
expected=$2
trap 'rm -f "$src/source.tar"' EXIT
actual=$(sha256sum "$src/source.tar")
actual=\${actual%% *}
[ "$actual" = "$expected" ] || { printf 'Source hash mismatch\\n' >&2; exit 1; }
mkdir "$src/tree"
tar -xf "$src/source.tar" -C "$src/tree"
# Nix store source archives retain read-only directory modes.
chmod -R u+w "$src/tree"
`;

/** Reads the staging directory the source script reported. */
export function parseSourceDir(stdout: string): string {
  const lines = stdout.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  const start = lines.indexOf(SOURCE_MARKER);
  if (start === -1) throw new Error('the host did not report a source staging directory');
  const line = lines[start + 1] ?? '';
  if (!line.startsWith('src=') || lines[start + 2] !== SOURCE_END) {
    throw new Error('the host sent an unexpected source staging response');
  }
  return validateRuntimePath(line.slice('src='.length));
}

/**
 * Consented install: stage the source, build with nix on the host, check the
 * launcher, then point the version link at the result. `undefined` means the
 * user declined and nothing on the host was touched.
 */
export async function installRuntime(deps: InstallDeps): Promise<string | undefined> {
  if (!VERSION.test(deps.version)) {
    throw new Error(`invalid runtime version: ${deps.version.slice(0, 80)}`);
  }
  const runtimeDir = validateRuntimePath(deps.runtimeDir);

  if (!(await deps.ask('Install? [y/N] '))) {
    deps.say('Cancelled. Nothing was changed on the host.');
    return undefined;
  }

  const staged = await deps.runScript(SOURCE_DIR_SCRIPT);
  if (staged.code !== 0) {
    throw new Error(`could not stage the Awrit source on the host (exit ${staged.code})`);
  }
  const src = parseSourceDir(staged.stdout);

  let built: HostScriptResult;
  try {
    let buildSource = src;
    if (deps.packagedSource) {
      const sent = await deps.runInput(
        ['tee', `${src}/source.tar`],
        Readable.from([deps.packagedSource]),
      );
      if (sent !== 0) throw new Error(`sending the Awrit source to the host failed (exit ${sent})`);
      const verified = await deps.runScript(VERIFY_SOURCE_SCRIPT, [
        src,
        createHash('sha256').update(deps.packagedSource).digest('hex'),
      ]);
      if (verified.code !== 0) throw new Error('Verifying the Awrit source on the host failed');
      buildSource = `${src}/tree`;
    } else {
      const sent = await deps.runInput(['tar', '-x', '-C', src], deps.archive());
      if (sent !== 0) throw new Error(`sending the Awrit source to the host failed (exit ${sent})`);
    }
    built = await deps.runScript(
      BUILD_SCRIPT,
      deps.packagedSource ? [deps.version, buildSource, src] : [deps.version, buildSource],
    );
  } catch (error) {
    await deps.runInput(['rm', '-rf', '--', src], Readable.from([])).catch(() => undefined);
    throw error;
  }
  if (built.code !== 0) {
    throw new Error(`building the Awrit runtime on the host failed (exit ${built.code})`);
  }

  return `${runtimeDir}/${deps.version}/bin/awrit`;
}
