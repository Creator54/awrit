import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  detectCapabilities,
  parsePositiveInt,
  probeKittenVersion,
  resolveKittenBinary,
  sanitizeControlEndpoint,
} from './capabilities';

describe('capabilities', () => {
  describe('parsePositiveInt', () => {
    test('parses valid positive integer strings', () => {
      expect(parsePositiveInt('1')).toBe(1);
      expect(parsePositiveInt('42')).toBe(42);
      expect(parsePositiveInt(' 123 ')).toBe(123);
      expect(parsePositiveInt('999999')).toBe(999999);
    });

    test('rejects non-positive numbers and zero', () => {
      expect(parsePositiveInt('0')).toBeNull();
      expect(parsePositiveInt('-1')).toBeNull();
      expect(parsePositiveInt('-42')).toBeNull();
    });

    test('rejects non-integers and invalid formats', () => {
      expect(parsePositiveInt('1.5')).toBeNull();
      expect(parsePositiveInt('abc')).toBeNull();
      expect(parsePositiveInt('12a')).toBeNull();
      expect(parsePositiveInt('a12')).toBeNull();
      expect(parsePositiveInt('')).toBeNull();
      expect(parsePositiveInt(undefined)).toBeNull();
      expect(parsePositiveInt('99999999999999999999999999')).toBeNull();
    });
  });

  describe('sanitizeControlEndpoint', () => {
    test('returns null for missing or empty input', () => {
      expect(sanitizeControlEndpoint(undefined)).toBeNull();
      expect(sanitizeControlEndpoint('')).toBeNull();
      expect(sanitizeControlEndpoint('   ')).toBeNull();
    });

    test('returns type and present without returning socket paths or secret queries', () => {
      const endpoint = sanitizeControlEndpoint('unix:/tmp/kitty-1234?token=secret123#frag');
      expect(endpoint).toEqual({
        present: true,
        type: 'unix',
      });
    });

    test('returns tcp type without returning host, port or auth credentials', () => {
      const endpoint = sanitizeControlEndpoint('tcp://user:password@localhost:12345?secret=abc');
      expect(endpoint).toEqual({
        present: true,
        type: 'tcp',
      });
    });

    test('handles other schemes safely', () => {
      const endpoint = sanitizeControlEndpoint('custom://somewhere?token=secret');
      expect(endpoint).toEqual({
        present: true,
        type: 'other',
      });
    });
  });

  describe('resolveKittenBinary', () => {
    let fixtureDir: string;
    const makeFixtureDir = () => {
      fixtureDir = mkdtempSync(path.join(tmpdir(), 'awrit-resolve-'));
    };

    test('detects executable binary in PATH', () => {
      makeFixtureDir();
      const fakeBinary = path.join(fixtureDir, 'kitten');
      writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n');
      chmodSync(fakeBinary, 0o755);

      const result = resolveKittenBinary(
        {
          PATH: fixtureDir,
        },
        [],
      );
      expect(result).toEqual({ binaryPath: fakeBinary, lookupScope: 'path' });

      rmSync(fixtureDir, { recursive: true, force: true });
    });

    test('detects executable binary in fallback profiles', () => {
      makeFixtureDir();
      const fakeBinary = path.join(fixtureDir, 'kitten');
      writeFileSync(fakeBinary, '#!/bin/sh\nexit 0\n');
      chmodSync(fakeBinary, 0o755);

      const result = resolveKittenBinary(
        {
          PATH: '/nonexistent/path',
        },
        [fixtureDir],
      );
      expect(result).toEqual({ binaryPath: fakeBinary, lookupScope: 'standard_profile' });

      rmSync(fixtureDir, { recursive: true, force: true });
    });

    test('ignores non-executable file', () => {
      makeFixtureDir();
      const fakeBinary = path.join(fixtureDir, 'kitten');
      writeFileSync(fakeBinary, 'not executable');
      chmodSync(fakeBinary, 0o644);

      const result = resolveKittenBinary(
        {
          PATH: fixtureDir,
        },
        [],
      );
      expect(result).toEqual({ binaryPath: null, lookupScope: 'none' });

      rmSync(fixtureDir, { recursive: true, force: true });
    });

    test('returns none when PATH and profile dirs are empty/invalid', () => {
      const result = resolveKittenBinary(
        {
          PATH: '/nonexistent/directory',
          HOME: '/nonexistent/home',
          USER: 'nobody',
        },
        ['/nonexistent/fallback'],
      );
      expect(result).toEqual({ binaryPath: null, lookupScope: 'none' });
    });
  });

  describe('detectCapabilities', () => {
    test('reports schemaVersion 1, eligible true, supported false when inside Kitty with TTY and kitten installed', async () => {
      const report = await detectCapabilities({
        env: {
          KITTY_WINDOW_ID: '7',
          KITTY_PID: '12345',
          TERM: 'xterm-kitty',
          KITTY_LISTEN_ON: 'unix:/tmp/mykitty?secret=token',
          KITTY_RC_PASSWORD: 'should-never-leak',
        },
        stdout: {
          isTTY: true,
          columns: 120,
          rows: 40,
        },
        kittenBinary: '/bin/kitten',
        probeVersion: async () => '0.49.1',
      });

      expect(report.schemaVersion).toBe(1);
      expect(report.detected.inKitty).toBe(true);
      expect(report.detected.kittyWindowId).toBe(7);
      expect(report.detected.kittyPid).toBe(12345);
      expect(report.detected.term).toBe('xterm-kitty');
      expect(report.detected.termHint).toBe(true);
      expect(report.detected.controlEndpoint).toEqual({
        present: true,
        type: 'unix',
      });
      expect(report.detected.controlAvailability).toBe('not-verified');
      expect(report.detected.verifiedGraphics).toBe(false);
      expect(report.detected.verifiedControl).toBe(false);

      expect(report.installed.kittenBinary).toBe('/bin/kitten');
      expect(report.installed.kittenVersion).toBe('0.49.1');
      expect(report.installed.lookupScope).toBe('path');
      expect(report.installed.icatAvailable).toBe(true);

      expect(report.stdout.isTTY).toBe(true);
      expect(report.stdout.columns).toBe(120);
      expect(report.stdout.rows).toBe(40);

      expect(report.modes.inline.supported).toBe(false);
      expect(report.modes.inline.eligible).toBe(true);
      expect(report.modes.inline.reason).toContain('ownership is not established');
      expect(report.modes.preferredStaticMode).toBe('none');
      expect(report.contentTypes.supported).toEqual([]);

      const serialized = JSON.stringify(report);
      expect(serialized).not.toContain('should-never-leak');
      expect(serialized).not.toContain('secret=token');
      expect(serialized).not.toContain('/tmp/mykitty');
    });

    test('marks eligible false when stdout is not a TTY (captured/redirected)', async () => {
      const report = await detectCapabilities({
        env: {
          KITTY_WINDOW_ID: '7',
          TERM: 'xterm-kitty',
        },
        stdout: {
          isTTY: false,
        },
        kittenBinary: '/bin/kitten',
        probeVersion: async () => '0.49.1',
      });

      expect(report.stdout.isTTY).toBe(false);
      expect(report.modes.inline.supported).toBe(false);
      expect(report.modes.inline.eligible).toBe(false);
      expect(report.modes.inline.reason).toContain('Captured or redirected stdout');
      expect(report.modes.preferredStaticMode).toBe('none');
      expect(report.contentTypes.supported).toEqual([]);
      expect(report.limitations.some((l) => l.includes('captured or redirected'))).toBe(true);
    });

    test('marks eligible false when kitten executable is not found', async () => {
      const report = await detectCapabilities({
        env: {
          KITTY_WINDOW_ID: '7',
          TERM: 'xterm-kitty',
        },
        stdout: {
          isTTY: true,
        },
        kittenBinary: null,
      });

      expect(report.installed.icatAvailable).toBe(false);
      expect(report.modes.inline.supported).toBe(false);
      expect(report.modes.inline.eligible).toBe(false);
      expect(report.modes.inline.reason).toContain('Kitten executable not found');
      expect(report.modes.preferredStaticMode).toBe('none');
      expect(report.contentTypes.supported).toEqual([]);
    });

    test('makes no assumption from TERM hint without valid KITTY_WINDOW_ID', async () => {
      const report = await detectCapabilities({
        env: {
          TERM: 'xterm-kitty',
        },
        stdout: {
          isTTY: true,
        },
        kittenBinary: '/bin/kitten',
        probeVersion: async () => '0.49.1',
      });

      expect(report.detected.termHint).toBe(true);
      expect(report.detected.inKitty).toBe(false);
      expect(report.detected.kittyWindowId).toBeNull();
      expect(report.modes.inline.supported).toBe(false);
      expect(report.modes.inline.eligible).toBe(false);
      expect(report.modes.inline.reason).toContain('Not running inside Kitty terminal');
      expect(report.modes.preferredStaticMode).toBe('none');
    });

    test('handles invalid KITTY_WINDOW_ID values defensively', async () => {
      for (const invalidId of ['0', '-1', 'abc', '12abc', '']) {
        const report = await detectCapabilities({
          env: {
            KITTY_WINDOW_ID: invalidId,
          },
          stdout: {
            isTTY: true,
          },
          kittenBinary: '/bin/kitten',
          skipVersionProbe: true,
        });

        expect(report.detected.kittyWindowId).toBeNull();
        expect(report.detected.inKitty).toBe(false);
        expect(report.modes.inline.supported).toBe(false);
        expect(report.modes.inline.eligible).toBe(false);
      }
    });

    test('probeKittenVersion handles missing binary gracefully', async () => {
      const version = await probeKittenVersion('/nonexistent/binary/kitten', 200);
      expect(version).toBeNull();
    });
  });
});

test('inline eligibility distinguishes explicit shell ownership from agent-owned TUI', async () => {
  const base = { stdout: { isTTY: true }, kittenBinary: '/kitten', skipVersionProbe: true };
  const env = { KITTY_WINDOW_ID: '1', AWRIT_TERMINAL_OWNER: 'shell' };
  expect((await detectCapabilities({ ...base, env })).modes.inline.supported).toBe(true);
  expect(
    (await detectCapabilities({ ...base, env: { ...env, CLAUDE_CODE: '1' } })).modes.inline
      .supported,
  ).toBe(false);
  expect(
    (await detectCapabilities({ ...base, env, stdout: { isTTY: false } })).modes.inline.supported,
  ).toBe(false);
});
