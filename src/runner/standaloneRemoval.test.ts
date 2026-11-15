import { expect, test } from 'bun:test';
import fs from 'node:fs';

const read = (file: string) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');

test('supported launchers build and start only the shared owner/client entries', () => {
  expect(fs.existsSync(new URL('../index.ts', import.meta.url))).toBe(false);

  const runner = read('./index.ts');
  expect(runner).not.toContain('AWRIT_LEGACY_STANDALONE');
  expect(runner).not.toContain('dist/index.js');
  expect(runner).toContain("join(root, 'src/browserOwner/main.ts')");
  expect(runner).toContain("join(root, 'src/terminal/main.ts')");

  const flake = read('../../flake.nix');
  expect(flake).not.toContain('AWRIT_LEGACY_STANDALONE');
  expect(flake).not.toContain('dist/index.js');
  expect(flake).toContain('dist/browserOwner/main.js');
  expect(flake).toContain('dist/terminal/main.js');
});

test('the installed launcher sends every command-line command to the command-line entry', () => {
  const flake = read('../../flake.nix');
  const routed = flake.match(/^\s+(capabilities\|[a-z|-]+)\)$/m)?.[1]?.split('|') ?? [];
  const cli = read('../presentation/cli.ts');
  const direct = [...cli.matchAll(/argv\[0\] === '([a-z-]+)'/g)].map((m) => m[1]);
  const { PRESENTATION_COMMANDS } =
    require('../presentation/args') as typeof import('../presentation/args');
  expect(routed.sort()).toEqual([...new Set([...PRESENTATION_COMMANDS, ...direct])].sort());
});
