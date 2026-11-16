import { execFile } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

export interface StdoutMetadata {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
}

export interface ControlEndpoint {
  present: boolean;
  type: 'unix' | 'tcp' | 'other';
}

export interface CapabilitiesReport {
  schemaVersion: 1;
  detected: {
    inKitty: boolean;
    kittyWindowId: number | null;
    kittyPid: number | null;
    term: string | null;
    termHint: boolean;
    controlEndpoint: ControlEndpoint | null;
    controlAvailability: 'unknown' | 'not-verified';
    verifiedGraphics: false;
    verifiedControl: false;
  };
  installed: {
    kittenBinary: string | null;
    kittenVersion: string | null;
    lookupScope: 'path' | 'standard_profile' | 'none';
    icatAvailable: boolean;
  };
  stdout: {
    isTTY: boolean;
    columns?: number;
    rows?: number;
  };
  modes: {
    inline: {
      supported: boolean;
      eligible: boolean;
      reason: string;
    };
    preferredStaticMode: 'inline' | 'none';
  };
  contentTypes: {
    supported: string[];
  };
  limitations: string[];
}

export interface DetectCapabilitiesOptions {
  env?: NodeJS.ProcessEnv;
  stdout?: StdoutMetadata;
  kittenBinary?: string | null;
  probeVersion?: (binaryPath: string) => Promise<string | null>;
  skipVersionProbe?: boolean;
  fallbackDirs?: string[];
}

export function parsePositiveInt(val: string | undefined): number | null {
  if (!val) return null;
  const trimmed = val.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num <= 0) return null;
  return num;
}

export function sanitizeControlEndpoint(raw: string | undefined): ControlEndpoint | null {
  if (!raw || !raw.trim()) return null;
  const trimmed = raw.trim();

  let type: 'unix' | 'tcp' | 'other' = 'other';
  if (trimmed.startsWith('unix:')) {
    type = 'unix';
  } else if (trimmed.startsWith('tcp:')) {
    type = 'tcp';
  }

  return {
    present: true,
    type,
  };
}

function isExecutableFile(filePath: string): boolean {
  try {
    accessSync(filePath, constants.X_OK);
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function resolveKittenBinary(
  env: NodeJS.ProcessEnv = process.env,
  fallbackDirs?: string[],
): {
  binaryPath: string | null;
  lookupScope: 'path' | 'standard_profile' | 'none';
} {
  const pathDirs = (env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, 'kitten');
    if (isExecutableFile(candidate)) {
      return { binaryPath: candidate, lookupScope: 'path' };
    }
  }

  const home = env.HOME || '';
  const user = env.USER || '';
  const standardDirs =
    fallbackDirs ??
    [
      '/run/current-system/sw/bin',
      home ? path.join(home, '.nix-profile', 'bin') : '',
      home ? path.join(home, '.local', 'bin') : '',
      user ? `/etc/profiles/per-user/${user}/bin` : '',
      '/nix/var/nix/profiles/default/bin',
      '/usr/bin',
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/Applications/kitty.app/Contents/MacOS',
    ].filter(Boolean);

  for (const dir of standardDirs) {
    const candidate = path.join(dir, 'kitten');
    if (isExecutableFile(candidate)) {
      return { binaryPath: candidate, lookupScope: 'standard_profile' };
    }
  }

  return { binaryPath: null, lookupScope: 'none' };
}

export function probeKittenVersion(binaryPath: string, timeoutMs = 1000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const child = execFile(
        binaryPath,
        ['--version'],
        {
          timeout: timeoutMs,
          maxBuffer: 64 * 1024,
          windowsHide: true,
          encoding: 'utf8',
        },
        (error, stdout) => {
          if (error || !stdout) {
            resolve(null);
            return;
          }
          const match = stdout.match(/(?:kitten|kitty)\s+([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:[^\s]*))/i);
          if (match?.[1]) {
            resolve(match[1].trim());
          } else {
            const firstLine = stdout.trim().split('\n')[0].trim();
            resolve(firstLine || null);
          }
        },
      );
      child.stdin?.end();
    } catch {
      resolve(null);
    }
  });
}

export async function detectCapabilities(
  options: DetectCapabilitiesOptions = {},
): Promise<CapabilitiesReport> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? {
    isTTY: process.stdout.isTTY,
    columns: process.stdout.columns,
    rows: process.stdout.rows,
  };

  const isTTY = Boolean(stdout.isTTY);
  const kittyWindowId = parsePositiveInt(env.KITTY_WINDOW_ID);
  const kittyPid = parsePositiveInt(env.KITTY_PID);
  const rawTerm = env.TERM ? env.TERM.trim() : null;
  const termHint = Boolean(rawTerm && (rawTerm === 'xterm-kitty' || rawTerm.includes('kitty')));
  const inKitty = kittyWindowId !== null;

  const controlEndpoint = sanitizeControlEndpoint(env.KITTY_LISTEN_ON);

  let binaryPath: string | null = null;
  let lookupScope: 'path' | 'standard_profile' | 'none' = 'none';

  if (options.kittenBinary !== undefined) {
    binaryPath = options.kittenBinary;
    lookupScope = binaryPath ? 'path' : 'none';
  } else {
    const resolved = resolveKittenBinary(env, options.fallbackDirs);
    binaryPath = resolved.binaryPath;
    lookupScope = resolved.lookupScope;
  }

  const icatAvailable = binaryPath !== null;

  let kittenVersion: string | null = null;
  if (binaryPath && !options.skipVersionProbe) {
    if (options.probeVersion) {
      kittenVersion = await options.probeVersion(binaryPath);
    } else {
      kittenVersion = await probeKittenVersion(binaryPath);
    }
  }

  const limitations: string[] = [
    'Inline images require explicit plain-shell terminal ownership; captured agent output cannot insert a transcript block',
    'Graphics protocol support and terminal ownership are unverified',
    'Remote control availability is unverified',
  ];

  let inlineEligible = false;
  let inlineReason = '';

  if (!isTTY) {
    inlineReason =
      'Captured or redirected stdout (non-TTY); inline presentation requires direct terminal';
    limitations.unshift('Stdout is captured or redirected; inline graphics not supported');
  } else if (!icatAvailable) {
    inlineReason = 'Kitten executable not found; icat is required for inline presentation';
    limitations.unshift('Kitten executable not found in PATH or standard profiles');
  } else if (!inKitty) {
    inlineReason = 'Not running inside Kitty terminal (valid KITTY_WINDOW_ID required)';
    limitations.unshift(
      'Not running inside a detected Kitty window (KITTY_WINDOW_ID missing or invalid)',
    );
  } else {
    inlineEligible = true;
    inlineReason =
      'Prerequisites met (TTY, Kitty window, kitten installed), but inline presentation is not yet implemented and terminal ownership is unverified';
  }

  const ownedShell = env.AWRIT_TERMINAL_OWNER === 'shell';
  const hostOwnsTui = [
    'CLAUDE_CODE',
    'CLAUDE_SESSION_ID',
    'CLAUDE_AGENT_ID',
    'CODEX',
    'OPENCODE',
    'TMUX',
    'STY',
    'ZELLIJ',
  ].some((key) => !!env[key]);
  const inlineSupported = inlineEligible && ownedShell && !hostOwnsTui;
  if (inlineEligible)
    inlineReason = inlineSupported
      ? 'Owned plain-shell inline image route available; graphics support still unverified'
      : 'TTY prerequisites detected, but exclusive plain-shell terminal ownership is not established';
  return {
    schemaVersion: 1,
    detected: {
      inKitty,
      kittyWindowId,
      kittyPid,
      term: rawTerm,
      termHint,
      controlEndpoint,
      controlAvailability: 'not-verified',
      verifiedGraphics: false,
      verifiedControl: false,
    },
    installed: {
      kittenBinary: binaryPath,
      kittenVersion,
      lookupScope,
      icatAvailable,
    },
    stdout: {
      isTTY,
      ...(stdout.columns !== undefined && stdout.columns > 0 ? { columns: stdout.columns } : {}),
      ...(stdout.rows !== undefined && stdout.rows > 0 ? { rows: stdout.rows } : {}),
    },
    modes: {
      inline: {
        supported: inlineSupported,
        eligible: inlineEligible,
        reason: inlineReason,
      },
      preferredStaticMode: inlineSupported ? 'inline' : 'none',
    },
    contentTypes: {
      supported: inlineSupported ? ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] : [],
    },
    limitations,
  };
}
