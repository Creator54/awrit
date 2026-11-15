import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('bundled resolver uses packaged content identity and refuses altered source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'awrit-resolver-'));
  try {
    const entry = join(root, 'entry.ts');
    writeFileSync(
      entry,
      `import {resolveRemoteRuntime} from ${JSON.stringify(join(import.meta.dir, 'resolveRuntime.ts'))}; resolveRemoteRuntime('fixture').then(console.log).catch(error => { console.error(error); process.exitCode=1; });`,
    );
    const result = await Bun.build({
      entrypoints: [entry],
      outdir: join(root, 'dist'),
      target: 'node',
      format: 'cjs',
    });
    expect(result.success).toBe(true);
    const source = join(root, 'lib/awrit/remote-install');
    mkdirSync(source, { recursive: true });
    const bytes = Buffer.from('fixture source');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const version = `2.0.5-s${sha256.slice(0, 24)}`;
    writeFileSync(join(source, 'source.tar'), bytes);
    writeFileSync(
      join(source, 'manifest.json'),
      JSON.stringify({ format: 1, version: '2.0.5', size: bytes.length, sha256 }),
    );
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const probe = [
      'AWRIT-PROBE-1',
      'os=Linux',
      'arch=aarch64',
      'kernel=fixture',
      'cpus=4',
      'memMiB=16000',
      'diskFreeMiB=40000',
      'xdgRuntime=true',
      'userns=true',
      'kvm=false',
      'nix=true',
      'node=true',
      'ffmpeg=true',
      'podman=false',
      'adb=false',
      'runtimeDir=/home/fixture/runtime',
      `runtime=${version}`,
      'AWRIT-PROBE-END',
    ].join('\n');
    writeFileSync(join(bin, 'ssh'), `#!/bin/sh\ncat >/dev/null\ncat <<'PROBE'\n${probe}\nPROBE\n`, {
      mode: 0o700,
    });
    const run = () =>
      spawnSync(process.execPath, [join(root, 'dist', 'entry.js')], {
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          AWRIT_LAUNCHER: join(bin, 'awrit'),
        },
        encoding: 'utf8',
        timeout: 10000,
      });
    const good = run();
    expect(good.stderr).not.toContain('error:');
    expect(good.status).toBe(0);
    expect(good.stdout.trim()).toBe(`/home/fixture/runtime/${version}/bin/awrit`);
    writeFileSync(join(source, 'source.tar'), Buffer.alloc(bytes.length));
    const bad = run();
    expect(bad.status).not.toBe(0);
    expect(bad.stderr).toContain('does not match its manifest');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
