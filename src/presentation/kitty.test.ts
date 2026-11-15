import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildKittyLaunchSpec, type ExecFileFn, launchKitty } from './kitty';

function createMockExec(handlers: {
  ls?: (args: string[]) => { stdout?: string; stderr?: string; error?: Error };
  launch?: (args: string[]) => { stdout?: string; stderr?: string; error?: Error };
}): { execFn: ExecFileFn; recordedCalls: { file: string; args: string[] }[] } {
  const recordedCalls: { file: string; args: string[] }[] = [];

  const execFn = ((
    file: string,
    args: string[],
    _options: any,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    recordedCalls.push({ file, args });
    const isLs = args.includes('ls');
    const isLaunch = args.includes('launch');

    if (isLs && handlers.ls) {
      const res = handlers.ls(args);
      callback(res.error ?? null, res.stdout ?? '', res.stderr ?? '');
    } else if (isLaunch && handlers.launch) {
      const res = handlers.launch(args);
      callback(res.error ?? null, res.stdout ?? '', res.stderr ?? '');
    } else {
      callback(new Error(`Unhandled mock command: ${args.join(' ')}`), '', '');
    }

    return { stdin: { end() {} } } as any;
  }) as unknown as ExecFileFn;

  return { execFn, recordedCalls };
}

describe('kitty presentation', () => {
  describe('buildKittyLaunchSpec', () => {
    test('uses AWRIT_LAUNCHER when present in env', () => {
      const spec = buildKittyLaunchSpec({
        env: { AWRIT_LAUNCHER: '/custom/bin/awrit' },
        target: 'https://example.com',
      });
      expect(spec.binary).toBe('/custom/bin/awrit');
      expect(spec.argv).toEqual(['https://example.com/']);
    });

    test('rejects when neither AWRIT_LAUNCHER nor explicit launcher is provided', () => {
      expect(() =>
        buildKittyLaunchSpec({
          env: {},
          target: 'https://example.com',
        }),
      ).toThrow('AWRIT_LAUNCHER environment variable or explicit launcher is required');
    });

    test('canonicalizes target file paths', () => {
      const spec = buildKittyLaunchSpec({
        launcher: '/bin/awrit',
        target: 'package.json',
        cwd: process.cwd(),
      });
      expect(spec.binary).toBe('/bin/awrit');
      expect(spec.argv).toEqual([pathToFileURL(path.resolve('package.json')).href]);
    });
  });

  describe('launchKitty validation', () => {
    test('rejects invalid or non-positive source window IDs', async () => {
      for (const invalid of [0, -1, '0', '-5', 'abc', '', '   ']) {
        expect(
          launchKitty({
            sourceWindowId: invalid as any,
            endpoint: 'unix:/tmp/test',
            kittenBinary: '/bin/kitten',
          }),
        ).rejects.toThrow('Invalid source window ID');
      }
    });

    test('rejects if explicit kitten binary is null without falling back to standard profile dirs', async () => {
      expect(
        launchKitty({
          sourceWindowId: 1,
          endpoint: 'unix:/tmp/test',
          kittenBinary: null,
          env: { PATH: '' },
        }),
      ).rejects.toThrow('Kitten executable not found in PATH or standard profiles');
    });

    test('rejects if remote control endpoint is missing (no host TTY fallback)', async () => {
      expect(
        launchKitty({
          sourceWindowId: 1,
          kittenBinary: '/bin/kitten',
          env: {},
        }),
      ).rejects.toThrow('Kitty remote control endpoint is required');
    });

    test('rejects inline mode for window launch', async () => {
      const { execFn } = createMockExec({
        ls: () => ({
          stdout: JSON.stringify([
            { id: 1, tabs: [{ id: 1, layout: 'splits', windows: [{ id: 42 }] }] },
          ]),
        }),
      });

      expect(
        launchKitty({
          sourceWindowId: 42,
          mode: 'inline',
          endpoint: 'unix:/tmp/test',
          kittenBinary: '/bin/kitten',
          execFileFn: execFn,
        }),
      ).rejects.toThrow('Inline mode cannot be launched');
    });
  });

  describe('source preflight via kitten @ ls', () => {
    test('rejects when source window is not found (never falls back to active)', async () => {
      const { execFn, recordedCalls } = createMockExec({
        ls: () => ({
          stdout: JSON.stringify([
            {
              id: 1,
              tabs: [
                {
                  id: 1,
                  layout: 'splits',
                  windows: [{ id: 10, title: 'other' }],
                },
              ],
            },
          ]),
        }),
      });

      await expect(
        launchKitty({
          sourceWindowId: 99,
          endpoint: 'unix:/tmp/test',
          kittenBinary: '/bin/kitten',
          execFileFn: execFn,
        }),
      ).rejects.toThrow('Source window 99 not found in Kitty session');

      expect(recordedCalls.some((c) => c.args.includes('launch'))).toBe(false);
    });

    test('rejects on invalid JSON from kitten @ ls', async () => {
      const { execFn } = createMockExec({
        ls: () => ({
          stdout: 'not-json-at-all',
        }),
      });

      await expect(
        launchKitty({
          sourceWindowId: 1,
          endpoint: 'unix:/tmp/test',
          kittenBinary: '/bin/kitten',
          execFileFn: execFn,
        }),
      ).rejects.toThrow('Invalid JSON');
    });

    test('rejects on remote control permission denied without leaking secrets', async () => {
      const { execFn } = createMockExec({
        ls: () => {
          const err = new Error('Process exited with 1');
          return {
            error: err,
            stderr: 'Error: remote control is not enabled with password=supersecrettoken123',
          };
        },
      });

      const promise = launchKitty({
        sourceWindowId: 1,
        endpoint: 'unix:/tmp/test',
        kittenBinary: '/bin/kitten',
        execFileFn: execFn,
      });

      await expect(promise).rejects.toThrow('Kitty remote control permission denied');
      await expect(promise).rejects.toThrow('[REDACTED]');
      await expect(promise).rejects.not.toThrow('supersecrettoken123');
    });

    test('handles output limits / maxBuffer gracefully', async () => {
      const { execFn } = createMockExec({
        ls: () => {
          const err = new Error('maxBuffer exceeded') as any;
          err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
          return {
            error: err,
            stderr: 'stdout maxBuffer length exceeded',
          };
        },
      });

      await expect(
        launchKitty({
          sourceWindowId: 1,
          endpoint: 'unix:/tmp/test',
          kittenBinary: '/bin/kitten',
          execFileFn: execFn,
        }),
      ).rejects.toThrow('Kitty command output exceeded limit');
    });
  });

  describe('split layout inspection and mode selection', () => {
    const splitsTree = [
      {
        id: 1,
        tabs: [
          {
            id: 1,
            layout: 'splits',
            windows: [{ id: 12, title: 'my-win' }],
          },
        ],
      },
    ];

    const stackTree = [
      {
        id: 1,
        tabs: [
          {
            id: 1,
            layout: 'stack',
            windows: [{ id: 12, title: 'my-win' }],
          },
        ],
      },
    ];

    test('explicit split succeeds when tab layout is splits', async () => {
      const { execFn, recordedCalls } = createMockExec({
        ls: () => ({ stdout: JSON.stringify(splitsTree) }),
        launch: () => ({ stdout: '55\n' }),
      });

      const receipt = await launchKitty({
        sourceWindowId: 12,
        mode: 'split',
        endpoint: 'unix:/tmp/test',
        kittenBinary: '/bin/kitten',
        execFileFn: execFn,
        env: { IN_NIX_SHELL: 'impure', ELECTRON_OVERRIDE_DIST_PATH: '/nix/test/bin',
          PATH: '/nix/test/bin:/usr/bin', LD_LIBRARY_PATH: '/nix/test/lib',
          XDG_DATA_DIRS: '/nix/test/share', AWRIT_ELECTRON: '/nix/test/bin/electron',
          SECRET_TOKEN: 'must-not-forward', TMPDIR: '/tmp/shell-specific' },
        launchSpec: { binary: '/bin/awrit', argv: ['https://example.com'] },
      });

      const launchEnvArgs = recordedCalls.find((c) => c.args.includes('launch'))?.args ?? [];
      expect(launchEnvArgs).toContain('--env=IN_NIX_SHELL=impure');
      expect(launchEnvArgs).toContain('--env=PATH=/nix/test/bin:/usr/bin');
      expect(launchEnvArgs).toContain('--env=LD_LIBRARY_PATH=/nix/test/lib');
      expect(launchEnvArgs).toContain('--env=AWRIT_ELECTRON=/nix/test/bin/electron');
      expect(launchEnvArgs.some((arg) => arg.includes('must-not-forward'))).toBe(false);
      expect(launchEnvArgs.some((arg) => arg.includes('shell-specific'))).toBe(false);
      expect(receipt).toEqual({
        id: 55,
        source: 12,
        mode: 'split',
        readiness: 'launched',
      });

      const launchCall = recordedCalls.find((c) => c.args.includes('launch'));
      expect(launchCall).toBeDefined();
      expect(launchCall?.args).toContain('--match=window_id:12');
      expect(launchCall?.args).toContain('--source-window=id:12');
      expect(launchCall?.args).toContain('--next-to=id:12');
      expect(launchCall?.args).toContain('--type=window');
      expect(launchCall?.args).toContain('--location=vsplit');
      expect(launchCall?.args).toContain('--bias=40');
      expect(launchCall?.args).toContain('--keep-focus');
      expect(launchCall?.args).toContain('--spacing=padding=0');
      expect(launchCall?.args).toContain('--spacing=margin=0');
      expect(launchCall?.args).toContain('--');
      expect(launchCall?.args).toContain('/bin/awrit');
      expect(launchCall?.args).toContain('https://example.com');
    });

    test('launch does not forward runtime environment without both Nix markers', async () => {
      for (const env of [
        { PATH: '/custom/bin', ELECTRON_OVERRIDE_DIST_PATH: '/custom/electron' },
        { PATH: '/custom/bin', IN_NIX_SHELL: 'impure' },
      ]) {
        const { execFn, recordedCalls } = createMockExec({
          ls: () => ({ stdout: JSON.stringify(splitsTree) }),
          launch: () => ({ stdout: '55\n' }),
        });
        await launchKitty({
          sourceWindowId: 12, mode: 'split', endpoint: 'unix:/tmp/test',
          kittenBinary: '/bin/kitten', execFileFn: execFn, env,
          launchSpec: { binary: '/bin/awrit', argv: [] },
        });
        const args = recordedCalls.find((call) => call.args.includes('launch'))?.args ?? [];
        expect(args.some((arg) => arg.startsWith('--env='))).toBe(false);
      }
    });

    test('explicit split rejects when tab layout is not splits', async () => {
      const { execFn, recordedCalls } = createMockExec({
        ls: () => ({ stdout: JSON.stringify(stackTree) }),
      });

      await expect(
        launchKitty({
          sourceWindowId: 12,
          mode: 'split',
          endpoint: 'unix:/tmp/test',
          kittenBinary: '/bin/kitten',
          execFileFn: execFn,
        }),
      ).rejects.toThrow('Cannot create split: tab layout is "stack", not "splits"');

      expect(recordedCalls.some((c) => c.args.includes('launch'))).toBe(false);
    });

    test('auto mode uses split when layout is splits', async () => {
      const { execFn, recordedCalls } = createMockExec({
        ls: () => ({ stdout: JSON.stringify(splitsTree) }),
        launch: () => ({ stdout: '60\n' }),
      });

      const receipt = await launchKitty({
        sourceWindowId: 12,
        mode: 'auto',
        endpoint: 'unix:/tmp/test',
        kittenBinary: '/bin/kitten',
        execFileFn: execFn,
        launchSpec: { binary: '/bin/awrit', argv: [] },
      });

      expect(receipt.mode).toBe('split');
      expect(receipt.fallbackReason).toBeUndefined();

      const launchCall = recordedCalls.find((c) => c.args.includes('launch'));
      expect(launchCall).toBeDefined();
      expect(launchCall?.args).toContain('--type=window');
      expect(launchCall?.args).toContain('--location=vsplit');
      expect(launchCall?.args).toContain('--bias=40');
    });

    test('auto mode falls back to tab when source window geometry is too narrow', async () => {
      const narrowSplitsTree = [
        {
          id: 1,
          tabs: [
            {
              id: 1,
              layout: 'splits',
              windows: [{ id: 12, columns: 60, lines: 24, title: 'narrow-win' }],
            },
          ],
        },
      ];

      const { execFn, recordedCalls } = createMockExec({
        ls: () => ({ stdout: JSON.stringify(narrowSplitsTree) }),
        launch: () => ({ stdout: '62\n' }),
      });

      const receipt = await launchKitty({
        sourceWindowId: 12,
        mode: 'auto',
        endpoint: 'unix:/tmp/test',
        kittenBinary: '/bin/kitten',
        execFileFn: execFn,
        launchSpec: { binary: '/bin/awrit', argv: [] },
      });

      expect(receipt.mode).toBe('tab');
      expect(receipt.fallbackReason).toContain('insufficient for vertical split');
      const launchCall = recordedCalls.find((c) => c.args.includes('launch'));
      expect(launchCall).toBeDefined();
      expect(launchCall?.args).toContain('--type=tab');
      expect(launchCall?.args).not.toContain('--location=vsplit');
    });

    test('auto mode falls back to tab with reason when layout is not splits', async () => {
      const { execFn, recordedCalls } = createMockExec({
        ls: () => ({ stdout: JSON.stringify(stackTree) }),
        launch: () => ({ stdout: '61\n' }),
      });

      const receipt = await launchKitty({
        sourceWindowId: 12,
        mode: 'auto',
        endpoint: 'unix:/tmp/test',
        kittenBinary: '/bin/kitten',
        execFileFn: execFn,
        launchSpec: { binary: '/bin/awrit', argv: [] },
      });

      expect(receipt.mode).toBe('tab');
      expect(receipt.fallbackReason).toContain('Tab layout is "stack", not "splits"');

      const launchCall = recordedCalls.find((c) => c.args.includes('launch'));
      expect(launchCall).toBeDefined();
      expect(launchCall?.args).toContain('--type=tab');
      expect(launchCall?.args).not.toContain('--location=vsplit');
      expect(launchCall?.args).toContain('--keep-focus');
      expect(launchCall?.args).toContain('--spacing=padding=0');
      expect(launchCall?.args).toContain('--spacing=margin=0');
    });

    test('tab mode launches tab with keep-focus', async () => {
      const { execFn, recordedCalls } = createMockExec({
        ls: () => ({ stdout: JSON.stringify(stackTree) }),
        launch: () => ({ stdout: '70\n' }),
      });

      const receipt = await launchKitty({
        sourceWindowId: 12,
        mode: 'tab',
        endpoint: 'unix:/tmp/test',
        kittenBinary: '/bin/kitten',
        execFileFn: execFn,
        launchSpec: { binary: '/bin/awrit', argv: [] },
      });

      expect(receipt.mode).toBe('tab');
      const launchCall = recordedCalls.find((c) => c.args.includes('launch'));
      expect(launchCall).toBeDefined();
      expect(launchCall?.args).toContain('--type=tab');
      expect(launchCall?.args).toContain('--keep-focus');
      expect(launchCall?.args).toContain('--spacing=padding=0');
      expect(launchCall?.args).toContain('--spacing=margin=0');
    });

    test('overlay mode launches without keep-focus by default', async () => {
      const { execFn, recordedCalls } = createMockExec({
        ls: () => ({ stdout: JSON.stringify(splitsTree) }),
        launch: () => ({ stdout: '71\n' }),
      });

      const receipt = await launchKitty({
        sourceWindowId: 12,
        mode: 'overlay',
        endpoint: 'unix:/tmp/test',
        kittenBinary: '/bin/kitten',
        execFileFn: execFn,
        launchSpec: { binary: '/bin/awrit', argv: [] },
      });

      expect(receipt.mode).toBe('overlay');
      const launchCall = recordedCalls.find((c) => c.args.includes('launch'));
      expect(launchCall).toBeDefined();
      expect(launchCall?.args).toContain('--type=overlay');
      expect(launchCall?.args).not.toContain('--keep-focus');
      expect(launchCall?.args).not.toContain('--spacing=padding=0');
      expect(launchCall?.args).toContain('--overlay');
    });

    test('window mode launches os-window', async () => {
      const { execFn, recordedCalls } = createMockExec({
        ls: () => ({ stdout: JSON.stringify(splitsTree) }),
        launch: () => ({ stdout: '72\n' }),
      });

      const receipt = await launchKitty({
        sourceWindowId: 12,
        mode: 'window',
        endpoint: 'unix:/tmp/test',
        kittenBinary: '/bin/kitten',
        execFileFn: execFn,
        launchSpec: { binary: '/bin/awrit', argv: [] },
      });

      expect(receipt.mode).toBe('window');
      const launchCall = recordedCalls.find((c) => c.args.includes('launch'));
      expect(launchCall).toBeDefined();
      expect(launchCall?.args).toContain('--type=os-window');
    });
  });

  describe('launch result parsing', () => {
    test('rejects non-numeric launch receipt ID', async () => {
      const { execFn } = createMockExec({
        ls: () => ({
          stdout: JSON.stringify([
            { id: 1, tabs: [{ id: 1, layout: 'splits', windows: [{ id: 10 }] }] },
          ]),
        }),
        launch: () => ({ stdout: 'not-a-number' }),
      });

      await expect(
        launchKitty({
          sourceWindowId: 10,
          endpoint: 'unix:/tmp/test',
          kittenBinary: '/bin/kitten',
          execFileFn: execFn,
          launchSpec: { binary: '/bin/awrit', argv: [] },
        }),
      ).rejects.toThrow('Invalid launched window ID received');
    });

    test('passes remote control authorization via --to and environment without exposing password in argv', async () => {
      let capturedEnv: NodeJS.ProcessEnv | undefined;
      const { execFn, recordedCalls } = createMockExec({
        ls: () => ({
          stdout: JSON.stringify([
            { id: 1, tabs: [{ id: 1, layout: 'splits', windows: [{ id: 10 }] }] },
          ]),
        }),
        launch: () => ({ stdout: '99\n' }),
      });

      const customExec: ExecFileFn = ((file: string, args: string[], options: any, cb: any) => {
        capturedEnv = options?.env;
        return execFn(file, args, options, cb);
      }) as unknown as ExecFileFn;

      await launchKitty({
        sourceWindowId: 10,
        endpoint: 'unix:/tmp/kitty-socket',
        password: 'my-secret-pass',
        kittenBinary: '/bin/kitten',
        execFileFn: customExec,
        launchSpec: { binary: '/bin/awrit', argv: [] },
      });

      expect(capturedEnv?.KITTY_RC_PASSWORD).toBe('my-secret-pass');
      for (const call of recordedCalls) {
        expect(call.args).toContain('--to=unix:/tmp/kitty-socket');
        expect(call.args.some((a) => a.includes('password'))).toBe(false);
      }
    });

    test('captured error does not leak child process argv in error message', async () => {
      const { execFn } = createMockExec({
        ls: () => {
          const err = new Error('Command failed: /bin/kitten @ ls --secret-flag-arg') as any;
          err.code = 'ENOENT';
          return {
            error: err,
            stderr: '',
          };
        },
      });

      const promise = launchKitty({
        sourceWindowId: 1,
        endpoint: 'unix:/tmp/test',
        kittenBinary: '/bin/kitten',
        execFileFn: execFn,
      });

      await expect(promise).rejects.toThrow('Kitty command failed: ENOENT');
      await expect(promise).rejects.not.toThrow('--secret-flag-arg');
    });
  });
});

test('rejects custom specs that would recursively enter presentation dispatch', async () => {
  const { execFn, recordedCalls } = createMockExec({
    ls: () => ({
      stdout: JSON.stringify([{ tabs: [{ layout: 'splits', windows: [{ id: 1 }] }] }]),
    }),
  });
  await expect(
    launchKitty({
      sourceWindowId: 1,
      endpoint: 'unix:/test',
      kittenBinary: '/fake/kitten',
      launchSpec: { binary: '/fake/awrit', argv: ['show', '--mode=split', 'https://example.com'] },
      execFileFn: execFn,
    }),
  ).rejects.toThrow('not presentation commands');
  expect(recordedCalls.some((call) => call.args.includes('launch'))).toBe(false);
});

test('overlay launch only lists and launches, never changes spacing or targets recent windows', async () => {
  // Any other remote command (set-spacing, a recent:N match) would hit the
  // mock's "Unhandled" error and fail the launch.
  const { execFn, recordedCalls } = createMockExec({
    ls: () => ({
      stdout: JSON.stringify([
        { tabs: [{ layout: 'splits', windows: [{ id: 1, columns: 120 }, { id: 5 }] }] },
      ]),
    }),
    launch: () => ({ stdout: '42\n' }),
  });

  const receipt = await launchKitty({
    sourceWindowId: 1,
    mode: 'overlay',
    target: 'https://example.com',
    endpoint: 'unix:/test-sock',
    kittenBinary: '/bin/kitten',
    execFileFn: execFn,
    env: { AWRIT_LAUNCHER: '/bin/awrit' },
  });

  expect(receipt.id).toBe(42);
  expect(recordedCalls.map((c) => c.args.find((a) => a === 'ls' || a === 'launch'))).toEqual([
    'ls',
    'launch',
  ]);
  const flat = recordedCalls.flatMap((c) => c.args);
  expect(flat.some((a) => a.includes('spacing'))).toBe(false);
  expect(flat.some((a) => a.includes('recent:'))).toBe(false);
  const launchArgs = recordedCalls[1].args;
  expect(launchArgs).toContain('--match=window_id:1');
  expect(launchArgs).toContain('--next-to=id:1');
});
