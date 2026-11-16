import { execFile } from 'node:child_process';
import path from 'node:path';
import type { PresentationMode } from './args';
import { parsePositiveInt, resolveKittenBinary } from './capabilities';
import { type PresentationTarget, resolvePresentationTarget } from './target';

export type ExecFileFn = typeof execFile;

export interface KittyLaunchSpec {
  binary: string;
  argv: string[];
}

export interface KittyLaunchOptions {
  sourceWindowId: number | string;
  mode?: PresentationMode;
  target?: PresentationTarget | string;
  launchSpec?: KittyLaunchSpec;
  cwd?: string;
  keepFocus?: boolean;
  endpoint?: string;
  password?: string;
  splitBias?: number;
  minSplitColumns?: number;
  env?: NodeJS.ProcessEnv;
  kittenBinary?: string | null;
  timeoutMs?: number;
  maxBuffer?: number;
  execFileFn?: ExecFileFn;
}

export interface KittyLaunchReceipt {
  id: number;
  source: number;
  mode: 'split' | 'tab' | 'overlay' | 'window';
  readiness: 'launched';
  fallbackReason?: string;
}

export interface BuildKittyLaunchSpecOptions {
  launcher?: string;
  target?: PresentationTarget | string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export function buildKittyLaunchSpec(options: BuildKittyLaunchSpecOptions = {}): KittyLaunchSpec {
  const env = options.env ?? process.env;
  const binary = options.launcher ?? env.AWRIT_LAUNCHER;
  if (!binary) {
    throw new Error('AWRIT_LAUNCHER environment variable or explicit launcher is required');
  }
  const argv: string[] = [];

  if (options.target) {
    const canonicalTarget =
      typeof options.target === 'string'
        ? resolvePresentationTarget(options.target, options.cwd).url
        : options.target.url;
    argv.push(canonicalTarget);
  }

  return { binary, argv };
}

function sanitizeStderr(raw: string): string {
  return raw
    .replace(/(password|secret|token)[=:][^\s&]+/gi, '$1=[REDACTED]')
    .replace(/(?:unix|tcp):[^\s]+/gi, '[REDACTED_ENDPOINT]')
    .trim();
}

function isPermissionDenied(msg: string): boolean {
  return /permission denied|remote control is not enabled|allow_remote_control|access denied|unauthorized/i.test(
    msg,
  );
}

function runKittenCommand(
  binary: string,
  args: string[],
  execOptions: {
    timeout?: number;
    maxBuffer?: number;
    env?: NodeJS.ProcessEnv;
    cwd?: string;
  },
  execFn?: ExecFileFn,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timeout = execOptions.timeout ?? 5000;
    const maxBuffer = execOptions.maxBuffer ?? 2 * 1024 * 1024;
    const fn = execFn ?? execFile;

    try {
      const child = fn(
        binary,
        args,
        {
          timeout,
          maxBuffer,
          windowsHide: true,
          encoding: 'utf8',
          env: execOptions.env,
          cwd: execOptions.cwd,
        },
        (error, stdout, stderr) => {
          const outStr = typeof stdout === 'string' ? stdout : String(stdout || '');
          const errStr = typeof stderr === 'string' ? stderr : String(stderr || '');

          if (error) {
            const sanitizedErr = errStr.trim()
              ? sanitizeStderr(errStr)
              : (error as any).code || 'execution failed';
            if (isPermissionDenied(sanitizedErr)) {
              reject(new Error(`Kitty remote control permission denied: ${sanitizedErr}`));
              return;
            }
            if ((error as any).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
              reject(new Error(`Kitty command output exceeded limit: ${sanitizedErr}`));
              return;
            }
            reject(new Error(`Kitty command failed: ${sanitizedErr}`));
            return;
          }

          resolve({ stdout: outStr, stderr: errStr });
        },
      );
      child?.stdin?.end();
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

export interface KittyControlOptions {
  endpoint?: string;
  password?: string;
  kittenBinary?: string | null;
  timeoutMs?: number;
  maxBuffer?: number;
  execFileFn?: ExecFileFn;
  env?: NodeJS.ProcessEnv;
}

async function runKittyRemote(
  command: string[],
  options: KittyControlOptions,
  maxBuffer?: number,
): Promise<{ stdout: string }> {
  const env = options.env ?? process.env;
  let kittenBinary = options.kittenBinary;
  if (kittenBinary === undefined) {
    kittenBinary = resolveKittenBinary(env).binaryPath;
  }
  if (!kittenBinary) {
    throw new Error('Kitten executable not found in PATH or standard profiles');
  }

  const endpoint = options.endpoint ?? env.KITTY_LISTEN_ON;
  if (!endpoint || !endpoint.trim()) {
    throw new Error(
      'Kitty remote control endpoint is required (KITTY_LISTEN_ON or options.endpoint)',
    );
  }

  const childEnv: NodeJS.ProcessEnv = { ...env };
  const password = options.password ?? env.KITTY_RC_PASSWORD;
  if (password) {
    childEnv.KITTY_RC_PASSWORD = password;
  }

  return runKittenCommand(
    kittenBinary,
    ['@', `--to=${endpoint.trim()}`, ...command],
    {
      timeout: options.timeoutMs ?? 5000,
      ...(maxBuffer === undefined ? {} : { maxBuffer }),
      env: childEnv,
    },
    options.execFileFn,
  );
}

export async function queryKittyWindows(options: KittyControlOptions = {}): Promise<any[]> {
  const lsResult = await runKittyRemote(['ls'], options, options.maxBuffer ?? 2 * 1024 * 1024);

  try {
    const osWindows = JSON.parse(lsResult.stdout);
    if (!Array.isArray(osWindows)) {
      throw new Error('Root output is not an array');
    }
    return osWindows;
  } catch (parseErr) {
    throw new Error(
      `Invalid JSON received from kitten @ ls: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
    );
  }
}

export async function closeKittyWindow(
  windowId: number,
  options: KittyControlOptions = {},
): Promise<void> {
  await runKittyRemote(['close-window', `--match=id:${windowId}`], options);
}

export async function focusKittyWindow(
  windowId: number | string,
  options: KittyControlOptions = {},
): Promise<boolean> {
  const numId = typeof windowId === 'number' ? windowId : parseInt(String(windowId), 10);
  if (!Number.isInteger(numId) || numId <= 0) return false;
  try {
    await runKittyRemote(['focus-window', `--match=id:${numId}`], options);
    return true;
  } catch {
    return false;
  }
}


export async function launchKitty(options: KittyLaunchOptions): Promise<KittyLaunchReceipt> {
  const env = options.env ?? process.env;

  const sourceId =
    typeof options.sourceWindowId === 'number'
      ? options.sourceWindowId
      : parsePositiveInt(options.sourceWindowId);

  if (sourceId === null || !Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error(`Invalid source window ID: ${options.sourceWindowId}`);
  }

  let kittenBinary = options.kittenBinary;
  if (kittenBinary === undefined) {
    kittenBinary = resolveKittenBinary(env).binaryPath;
  }
  if (!kittenBinary) {
    throw new Error('Kitten executable not found in PATH or standard profiles');
  }

  let endpoint = options.endpoint ?? env.KITTY_LISTEN_ON;
  if (!endpoint || !endpoint.trim()) {
    throw new Error(
      'Kitty remote control endpoint is required (KITTY_LISTEN_ON or options.endpoint)',
    );
  }

  const childEnv: NodeJS.ProcessEnv = { ...env };
  const password = options.password ?? env.KITTY_RC_PASSWORD;
  if (password) {
    childEnv.KITTY_RC_PASSWORD = password;
  }

  const controlArgs: string[] = ['@', `--to=${endpoint.trim()}`];

  // Preflight: query kitten @ ls
  let osWindows: any[];
  try {
    osWindows = await queryKittyWindows({
      endpoint,
      password,
      kittenBinary,
      timeoutMs: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      execFileFn: options.execFileFn,
      env: childEnv,
    });
  } catch (err) {
    // If querying failed on a dead endpoint, try self-healing
    try {
      const { resolveKittyContext } = await import('./kittyDiscovery');
      const ctx = await resolveKittyContext({ env, timeoutMs: 40 });
      if (ctx && ctx.endpoint !== endpoint) {
        endpoint = ctx.endpoint;
        controlArgs[1] = `--to=${endpoint.trim()}`;
        osWindows = await queryKittyWindows({
          endpoint,
          password,
          kittenBinary,
          timeoutMs: options.timeoutMs,
          maxBuffer: options.maxBuffer,
          execFileFn: options.execFileFn,
          env: childEnv,
        });
      } else {
        throw err;
      }
    } catch {
      throw err;
    }
  }

  // ponytail: O(n) scan across tabs/windows in kitten @ ls JSON; acceptable for typical Kitty window counts
  let matchedWindow: any = null;
  let matchedTab: any = null;

  for (const osWin of osWindows) {
    if (!Array.isArray(osWin?.tabs)) continue;
    for (const tab of osWin.tabs) {
      if (!Array.isArray(tab?.windows)) continue;
      for (const win of tab.windows) {
        if (win?.id === sourceId) {
          matchedWindow = win;
          matchedTab = tab;
          break;
        }
      }
      if (matchedWindow) break;
    }
    if (matchedWindow) break;
  }

  if (!matchedWindow || !matchedTab) {
    throw new Error(`Source window ${sourceId} not found in Kitty session`);
  }

  const tabLayout =
    typeof matchedTab.layout === 'string' ? matchedTab.layout.trim().toLowerCase() : '';
  const isSplitsLayout = tabLayout === 'splits';

  const sourceColumns =
    typeof matchedWindow?.columns === 'number' && Number.isFinite(matchedWindow.columns)
      ? matchedWindow.columns
      : null;
  const minSplitColumns = options.minSplitColumns ?? 80;
  const hasInsufficientGeometry = sourceColumns !== null && sourceColumns < minSplitColumns;

  const requestedMode: PresentationMode = options.mode ?? 'auto';
  if (requestedMode === 'inline') {
    throw new Error('Inline mode cannot be launched as a Kitty window');
  }

  let actualMode: 'split' | 'tab' | 'overlay' | 'window';
  let fallbackReason: string | undefined;

  if (requestedMode === 'split') {
    if (!isSplitsLayout) {
      throw new Error(
        `Cannot create split: tab layout is "${matchedTab.layout || 'unknown'}", not "splits"`,
      );
    }
    actualMode = 'split';
  } else if (requestedMode === 'auto') {
    if (!isSplitsLayout) {
      actualMode = 'tab';
      fallbackReason = `Tab layout is "${matchedTab.layout || 'unknown'}", not "splits"; fell back to tab`;
    } else if (hasInsufficientGeometry) {
      actualMode = 'tab';
      fallbackReason = `Source window width (${sourceColumns} columns) is insufficient for vertical split (minimum ${minSplitColumns}); fell back to tab`;
    } else {
      actualMode = 'split';
    }
  } else if (requestedMode === 'tab') {
    actualMode = 'tab';
  } else if (requestedMode === 'overlay') {
    actualMode = 'overlay';
  } else if (requestedMode === 'window') {
    actualMode = 'window';
  } else {
    throw new Error(`Unsupported presentation mode: ${requestedMode}`);
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const spec =
    options.launchSpec ??
    buildKittyLaunchSpec({
      target: options.target,
      cwd,
      env: childEnv,
    });

  const launchBinary = spec.binary;
  if (['show', 'inline', 'capabilities', 'snapshot', 'setup'].includes(spec.argv[0] ?? '')) {
    throw new Error('Viewer launch must use a URL, not presentation commands');
  }
  const launchArgv = [...spec.argv];
  if (actualMode === 'overlay' && !launchArgv.includes('--overlay')) {
    launchArgv.push('--overlay');
  }
  if (!launchArgv.some((a) => a.startsWith('--source-window-id'))) {
    launchArgv.push(`--source-window-id=${sourceId}`);
  }

  let typeFlag: string;
  if (actualMode === 'split') {
    typeFlag = '--type=window';
  } else if (actualMode === 'tab') {
    typeFlag = '--type=tab';
  } else if (actualMode === 'overlay') {
    typeFlag = '--type=overlay';
  } else {
    typeFlag = '--type=os-window';
  }

  const shouldKeepFocus = options.keepFocus ?? actualMode !== 'overlay';
  const bias = options.splitBias ?? 40;

  // Remote launches otherwise inherit Kitty's original environment, causing a
  // checkout launcher to evaluate Nix again even when its caller is in the shell.
  // Forward only the shell's runtime requirements, not credentials or TMPDIR.
  const shellEnv = childEnv.IN_NIX_SHELL && childEnv.ELECTRON_OVERRIDE_DIST_PATH
    ? ['IN_NIX_SHELL', 'ELECTRON_OVERRIDE_DIST_PATH', 'PATH', 'LD_LIBRARY_PATH',
        'XDG_DATA_DIRS', 'AWRIT_ELECTRON']
        .filter((key) => childEnv[key] !== undefined)
        .map((key) => `--env=${key}=${childEnv[key]}`)
    : [];
  const launchArgs = [
    ...controlArgs,
    'launch',
    `--match=window_id:${sourceId}`,
    `--source-window=id:${sourceId}`,
    `--next-to=id:${sourceId}`,
    `--cwd=${cwd}`,
    typeFlag,
    ...(actualMode !== 'overlay' ? ['--spacing=padding=0', '--spacing=margin=0'] : []),
    ...(actualMode === 'split' ? ['--location=vsplit', `--bias=${bias}`] : []),
    ...(shouldKeepFocus ? ['--keep-focus'] : []),
    ...shellEnv,
    '--',
    launchBinary,
    ...launchArgv,
  ];

  const launchResult = await runKittenCommand(
    kittenBinary,
    launchArgs,
    {
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
      env: childEnv,
      cwd,
    },
    options.execFileFn,
  );

  const rawLaunchId = launchResult.stdout.trim();
  const launchedId = parsePositiveInt(rawLaunchId);
  if (launchedId === null) {
    throw new Error(`Invalid launched window ID received from kitten @ launch: "${rawLaunchId}"`);
  }
  return {
    id: launchedId,
    source: sourceId,
    mode: actualMode,
    readiness: 'launched',
    ...(fallbackReason ? { fallbackReason } : {}),
  };
}
