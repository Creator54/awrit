import { describe, expect, test } from 'bun:test';
import { Readable } from 'node:stream';
import {
  BUILD_SCRIPT,
  type InstallDeps,
  installPlan,
  installRuntime,
  PROBE_SCRIPT,
  type ProbeResult,
  parseProbe,
  SOURCE_DIR_SCRIPT,
  VERIFY_SOURCE_SCRIPT,
} from './install';
import { sshCommandArgv } from './sshCommand';

const BANNER = [
  'Last login: Tue Nov 4 10:00:00 2025 from 127.0.0.1',
  'Welcome to the host',
  '',
].join('\n');

function probeBlock(overrides: Record<string, string> = {}, runtimes: string[] = []): string {
  const values: Record<string, string> = {
    os: 'Linux',
    arch: 'aarch64',
    kernel: '6.18.55',
    cpus: '8',
    memMiB: '16000',
    diskFreeMiB: '40000',
    xdgRuntime: 'true',
    userns: 'true',
    kvm: 'false',
    nix: 'true',
    node: 'true',
    ffmpeg: 'true',
    podman: 'false',
    adb: 'true',
    runtimeDir: '/home/you/.local/share/awrit/runtime',
    ...overrides,
  };
  const lines = ['AWRIT-PROBE-1'];
  for (const [key, value] of Object.entries(values)) {
    if (value !== '') lines.push(`${key}=${value}`);
  }
  lines.push(...runtimes.map((name) => `runtime=${name}`));
  lines.push('AWRIT-PROBE-END');
  return lines.join('\n');
}

function parsed(overrides: Record<string, string> = {}, runtimes: string[] = []): ProbeResult {
  return parseProbe(`${BANNER}\n${probeBlock(overrides, runtimes)}\n`);
}

const localRuntime = { version: '2.0.5' };

// Real output from `ssh -o BatchMode=yes -T phoenix sh -s`, read-only and sanitized:
// no host names or addresses. Phoenix is an ARM64 Linux host without KVM.
const PHOENIX_PROBE = `AWRIT-PROBE-1
os=Linux
arch=aarch64
kernel=6.18.55
cpus=4
memMiB=23964
diskFreeMiB=15712
xdgRuntime=true
userns=true
kvm=false
nix=true
node=true
ffmpeg=false
podman=false
adb=true
runtimeDir=/home/you/.local/share/awrit/runtime
AWRIT-PROBE-END`;

describe('probe script', () => {
  test('is a fixed POSIX script with marked output', () => {
    expect(PROBE_SCRIPT).toContain('AWRIT-PROBE-1');
    expect(PROBE_SCRIPT.trimEnd().endsWith("printf 'AWRIT-PROBE-END\\n'")).toBe(true);
    expect(PROBE_SCRIPT).not.toContain('sudo');
    expect(PROBE_SCRIPT).toContain("printf 'runtimeDir=%s");
  });
});

describe('parseProbe', () => {
  test('ignores login banners before the marker', () => {
    const result = parsed();
    expect(result.os).toBe('Linux');
    expect(result.arch).toBe('aarch64');
    expect(result.kernel).toBe('6.18.55');
    expect(result.cpus).toBe(8);
    expect(result.memMiB).toBe(16000);
    expect(result.diskFreeMiB).toBe(40000);
    expect(result.xdgRuntime).toBe(true);
    expect(result.userns).toBe(true);
    expect(result.kvm).toBe(false);
    expect(result.tools).toEqual({
      nix: true,
      node: true,
      ffmpeg: true,
      podman: false,
      adb: true,
    });
    expect(result.runtimeDir).toBe('/home/you/.local/share/awrit/runtime');
    expect(result.runtimes).toEqual([]);
  });

  test('normalizes known architectures and rejects unknown ones', () => {
    expect(parsed({ arch: 'x86_64' }).arch).toBe('x86_64');
    expect(parsed({ arch: 'amd64' }).arch).toBe('x86_64');
    expect(parsed({ arch: 'arm64' }).arch).toBe('aarch64');
    expect(parsed({ arch: 'riscv64' }).arch).toBe('unsupported');
  });

  test('keeps installed runtime names', () => {
    const result = parsed({}, ['2.0.5', 'next', '2.0.4']);
    expect(result.runtimes).toEqual(['2.0.5', 'next', '2.0.4']);
  });

  test('parses a real read-only Phoenix probe', () => {
    const result = parseProbe(`${BANNER}\n${PHOENIX_PROBE}\n`);
    expect(result).toEqual({
      os: 'Linux',
      arch: 'aarch64',
      kernel: '6.18.55',
      cpus: 4,
      memMiB: 23964,
      diskFreeMiB: 15712,
      xdgRuntime: true,
      userns: true,
      kvm: false,
      tools: { nix: true, node: true, ffmpeg: false, podman: false, adb: true },
      runtimeDir: '/home/you/.local/share/awrit/runtime',
      runtimes: [],
    });
    expect(installPlan(result, { version: '2.0.5' }).action).toBe('install');
  });

  test('rejects output without the marker', () => {
    expect(() => parseProbe('os=Linux\nAWRIT-PROBE-END\n')).toThrow(/marker/);
  });

  test('rejects output without the end marker', () => {
    expect(() => parseProbe('AWRIT-PROBE-1\nos=Linux\n')).toThrow(/AWRIT-PROBE-END/);
  });

  test('rejects unknown keys', () => {
    expect(() => parseProbe(probeBlock({ surprise: 'yes' }))).toThrow(/unexpected probe key/i);
  });

  test('rejects duplicate keys', () => {
    const block = probeBlock().replace('cpus=8', 'cpus=8\ncpus=9');
    expect(() => parseProbe(block)).toThrow(/duplicate/i);
  });

  test('rejects missing keys', () => {
    expect(() => parseProbe(probeBlock({ ffmpeg: '' }))).toThrow(/missing/i);
  });

  test('rejects control characters', () => {
    expect(() => parseProbe(probeBlock({ kernel: '6.18\u001b[31m' }))).toThrow(/control/i);
    expect(() => parseProbe(probeBlock({ kernel: '6.18\u009b31m' }))).toThrow(/control/i);
  });

  test('rejects non-numeric numbers', () => {
    expect(() => parseProbe(probeBlock({ memMiB: 'lots' }))).toThrow(/memMiB/);
    expect(() => parseProbe(probeBlock({ diskFreeMiB: '-1' }))).toThrow(/diskFreeMiB/);
  });

  test('rejects values other than true and false', () => {
    expect(() => parseProbe(probeBlock({ kvm: 'yes' }))).toThrow(/kvm/);
  });

  test('rejects unsafe or duplicate runtime names', () => {
    expect(() => parseProbe(probeBlock({}, ['../escape']))).toThrow(/runtime/);
    expect(() => parseProbe(probeBlock({}, ['.']))).toThrow(/runtime/);
    expect(() => parseProbe(probeBlock({}, ['..']))).toThrow(/runtime/);
    expect(() => parseProbe(probeBlock({}, ['.hidden']))).toThrow(/runtime/);
    expect(() => parseProbe(probeBlock({}, ['2.0.5', '2.0.5']))).toThrow(/duplicate/i);
  });

  test('rejects an unsafe or missing runtime directory', () => {
    expect(() => parsed({ runtimeDir: '~/.local/share/awrit/runtime' })).toThrow(/runtimeDir/);
    expect(() => parsed({ runtimeDir: '/home/you/../../etc' })).toThrow(/runtimeDir/);
    expect(() => parsed({ runtimeDir: '/home/you/a b' })).toThrow(/runtimeDir/);
    expect(() => parsed({ runtimeDir: '' })).toThrow(/runtimeDir/);
  });

  test('rejects trailing output after the end marker', () => {
    expect(() => parseProbe(`${probeBlock()}\nlogout\n`)).toThrow(/after AWRIT-PROBE-END/);
  });
});

describe('installPlan', () => {
  test('asks for consent with the destination, version and disk use', () => {
    const plan = installPlan(parsed(), localRuntime);
    expect(plan.action).toBe('install');
    const text = plan.consentText ?? '';
    expect(text).toContain('2.0.5');
    expect(text).toContain('/home/you/.local/share/awrit/runtime/2.0.5');
    expect(text).toContain('about 3 GiB');
    expect(text).toContain('your user only');
    expect(text).toContain('No sudo');
    expect(text).toContain('no system service');
  });

  test('consent names the source build and the host build tool', () => {
    const text = installPlan(parsed(), localRuntime).consentText ?? '';
    expect(text).toContain('Route:');
    expect(text).toContain('nix builds the runtime on this host from this Awrit');
    expect(text).toContain('over SSH');
    expect(text).toContain('never touched');
  });

  test('does nothing when the runtime version is already installed', () => {
    const plan = installPlan(parsed({}, ['2.0.5']), localRuntime);
    expect(plan.action).toBe('none');
    expect(plan.consentText).toBeUndefined();
    expect(plan.reasons.join(' ')).toContain('already installed');
  });

  test('needs nix, because the host builds its own runtime', () => {
    const plan = installPlan(parsed({ nix: 'false' }), localRuntime);
    expect(plan.action).toBe('unsupported');
    expect(plan.reasons.join(' ')).toContain('nix');
  });

  test('uses an installed runtime even when nix is not on the PATH', () => {
    expect(installPlan(parsed({ nix: 'false' }, ['2.0.5']), localRuntime).action).toBe('none');
  });

  test('accepts a host whose architecture differs from the local one', () => {
    expect(installPlan(parsed({ arch: 'x86_64' }), localRuntime).action).toBe('install');
  });

  test('supports only Linux and known architectures', () => {
    expect(installPlan(parsed({ os: 'Darwin' }), localRuntime).action).toBe('unsupported');
    expect(installPlan(parsed({ arch: 'riscv64' }), localRuntime).action).toBe('unsupported');
  });

  test('refuses to run without the Chromium sandbox', () => {
    const plan = installPlan(parsed({ userns: 'false' }), localRuntime);
    expect(plan.action).toBe('unsupported');
    expect(plan.reasons.join(' ')).toContain('sandbox');
    expect(plan.reasons.join(' ')).not.toContain('--no-sandbox');
  });

  test('notes missing KVM without blocking installation', () => {
    const plan = installPlan(parsed({ kvm: 'false' }), localRuntime);
    expect(plan.action).toBe('install');
    expect(plan.reasons.join(' ')).toContain('Android emulators');
  });

  test('rejects an unusable version before building paths', () => {
    expect(() => installPlan(parsed(), { version: '../2.0.5' })).toThrow();
    expect(() => installPlan(parsed(), { version: '.' })).toThrow();
    expect(() => installPlan(parsed(), { version: '..' })).toThrow();
  });
});

const STAGED = ['AWRIT-SRC-1', 'src=/home/you/.cache/awrit/src.abc123', 'AWRIT-SRC-END', ''].join(
  '\n',
);

function recorder() {
  const scripts: { script: string; args: string[] }[] = [];
  const commands: string[][] = [];
  const said: string[] = [];
  const deps: InstallDeps = {
    version: '2.0.5',
    runtimeDir: '/home/you/.local/share/awrit/runtime',
    runScript: async (script, args = []) => {
      scripts.push({ script, args });
      return { code: 0, stdout: STAGED };
    },
    runInput: async (argv, input) => {
      commands.push(argv);
      input.resume();
      return 0;
    },
    archive: () => Readable.from(['archive bytes']),
    ask: async () => true,
    say: (line) => said.push(line),
  };
  return { deps, scripts, commands, said };
}

describe('installRuntime', () => {
  test('declining consent changes nothing on the host', async () => {
    const run = recorder();
    expect(await installRuntime({ ...run.deps, ask: async () => false })).toBeUndefined();
    expect(run.scripts).toHaveLength(0);
    expect(run.commands).toHaveLength(0);
    expect(run.said.join(' ')).toContain('Nothing was changed');
  });

  test('stages the source, sends it, then builds the expected runtime', async () => {
    const run = recorder();
    expect(await installRuntime(run.deps)).toBe(
      '/home/you/.local/share/awrit/runtime/2.0.5/bin/awrit',
    );
    expect(run.scripts.map((call) => call.script)).toEqual([SOURCE_DIR_SCRIPT, BUILD_SCRIPT]);
    expect(run.commands).toEqual([['tar', '-x', '-C', '/home/you/.cache/awrit/src.abc123']]);
    expect(run.scripts[1]?.args).toEqual(['2.0.5', '/home/you/.cache/awrit/src.abc123']);
  });

  for (const accepted of [true, false])
    test(`packaged transfer verifies before build: ${accepted}`, async () => {
      const run = recorder();
      const bytes = Buffer.from('verified package fixture');
      let received = Buffer.alloc(0);
      const result = installRuntime({
        ...run.deps,
        packagedSource: bytes,
        archive: () => {
          throw new Error('Checkout archive must not be used');
        },
        runInput: async (argv, input) => {
          expect(() => sshCommandArgv('fixture', argv)).not.toThrow();
          run.commands.push(argv);
          for await (const chunk of input) received = Buffer.concat([received, Buffer.from(chunk)]);
          return 0;
        },
        runScript: async (script, args) => {
          if (script === VERIFY_SOURCE_SCRIPT) {
            run.scripts.push({ script, args: args ?? [] });
            return { code: accepted ? 0 : 1, stdout: '' };
          }
          return run.deps.runScript(script, args);
        },
      });
      if (accepted) {
        await result;
        expect(run.scripts.at(-1)?.args).toEqual([
          '2.0.5',
          '/home/you/.cache/awrit/src.abc123/tree',
          '/home/you/.cache/awrit/src.abc123',
        ]);
      } else {
        await expect(result).rejects.toThrow('Verifying');
        expect(run.scripts.some((call) => call.script === BUILD_SCRIPT)).toBe(false);
      }
      expect(received).toEqual(bytes);
      if (!accepted)
        expect(run.commands.at(-1)).toEqual([
          'rm',
          '-rf',
          '--',
          '/home/you/.cache/awrit/src.abc123',
        ]);
    });

  test('a failed upload removes the staged directory and does not build', async () => {
    const run = recorder();
    const deps: InstallDeps = {
      ...run.deps,
      runInput: async (argv, input) => {
        run.commands.push(argv);
        input.resume();
        return argv[0] === 'tar' ? 2 : 0;
      },
    };
    await expect(installRuntime(deps)).rejects.toThrow('sending the Awrit source');
    expect(run.commands[1]).toEqual(['rm', '-rf', '--', '/home/you/.cache/awrit/src.abc123']);
    expect(run.scripts.map((call) => call.script)).toEqual([SOURCE_DIR_SCRIPT]);
  });

  test('a build that cannot start removes the staged directory', async () => {
    const run = recorder();
    const deps: InstallDeps = {
      ...run.deps,
      runScript: async (script, args) => {
        if (script === BUILD_SCRIPT) throw new Error('ssh vanished');
        return run.deps.runScript(script, args);
      },
    };
    await expect(installRuntime(deps)).rejects.toThrow('ssh vanished');
    expect(run.commands.at(-1)).toEqual(['rm', '-rf', '--', '/home/you/.cache/awrit/src.abc123']);
  });

  test('the build script verifies a partial link before the final one', () => {
    expect(BUILD_SCRIPT).toContain('nix build --out-link "$runtime/$version.partial" "path:$src"');
    expect(BUILD_SCRIPT).toContain('"$runtime/$version.partial/bin/awrit" --version');
    expect(BUILD_SCRIPT).toContain('nix build --out-link "$runtime/$version" "path:$src"');
    expect(BUILD_SCRIPT).toContain('rm -f "$runtime/$version.partial"');
    expect(BUILD_SCRIPT).toContain('rm -rf "$cleanup"');
    expect(BUILD_SCRIPT).not.toContain('sudo');
  });

  test('rejects an unsafe staging directory from the host', async () => {
    const run = recorder();
    const deps = {
      ...run.deps,
      runScript: async () => ({ code: 0, stdout: 'AWRIT-SRC-1\nsrc=../etc\nAWRIT-SRC-END\n' }),
    };
    await expect(installRuntime(deps)).rejects.toThrow(/runtime path/i);
  });

  test('fails when the build fails and does not claim success', async () => {
    const run = recorder();
    const deps = {
      ...run.deps,
      runScript: async (script: string, args: string[] = []) =>
        script === BUILD_SCRIPT ? { code: 1, stdout: '' } : run.deps.runScript(script, args),
    };
    await expect(installRuntime(deps)).rejects.toThrow(/building the Awrit runtime/);
  });
});
