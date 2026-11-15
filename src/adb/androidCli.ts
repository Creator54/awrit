import type { Option, ParsedOptions } from '../args';
import { possibleOptions } from '../args';
import { executeDeviceAction, parseResolution, RESOLUTION_FORMAT } from './androidManager';

export const ANDROID_COMMANDS = [
  'doctor',
  'list',
  'show',
  'prune',
  'create',
  'start',
  'stop',
  'delete',
  'view',
  'screenshot',
  'install',
  'reverse',
  'logcat',
  'build',
] as const;

export const DEVICE_COMMAND_OPTIONS: Record<(typeof ANDROID_COMMANDS)[number], Option[]> = {
  doctor: [],
  list: [],
  show: [],
  prune: ['yes'],
  create: ['api', 'image', 'device', 'resolution', 'port'],
  start: ['force'],
  stop: [],
  delete: ['force', 'yes'],
  view: ['host', 'remote-awrit', 'session', 'max-size', 'bitrate', 'debug-port'],
  screenshot: ['out'],
  install: [],
  reverse: [],
  logcat: [],
  build: ['accept-license', 'tools-url', 'tools-sha256'],
};

function isJsonObjectMessage(message: string): boolean {
  try {
    const parsed: unknown = JSON.parse(message);
    return typeof parsed === 'object' && parsed !== null;
  } catch {
    return false;
  }
}

/**
 * Runs an `awrit device <verb>` command without Electron. Returns the process exit code, or
 * null for `view`, which needs the Electron viewer and is handled by the caller.
 */
export async function runAndroidCli(options: ParsedOptions): Promise<number | null> {
  if (options.host !== undefined) {
    const subcommand = typeof options.deviceCommand === 'string' ? options.deviceCommand.trim() : 'list';
    if (subcommand === 'view' && options.nonFlagArgs?.[0]) {
      if (options.json || options.nonFlagArgs.length !== 1)
        throw new Error(
          'Remote Android view needs one device and an interactive terminal, not --json.',
        );
      const device = options.nonFlagArgs[0];
      if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(device))
        throw new Error('Invalid Android device selector');
      const { runRemoteShow } = await import('../remote/client');
      const { resolveRemoteRuntime } = await import('../remote/resolveRuntime');
      const runtimePath = await resolveRemoteRuntime(options.host, options['remote-awrit']);
      if (runtimePath === undefined) return 1;
      return runRemoteShow({
        alias: options.host,
        url: `android://${encodeURIComponent(options.nonFlagArgs[0])}`,
        android: options.nonFlagArgs[0],
        runtimePath,
        session: options.session,
      });
    }
    console.log(
      options.json
        ? JSON.stringify({
            error: '--host is supported only by device view; no local device action was started.',
          })
        : '--host is supported only by device view; no local device action was started.',
    );
    return 2;
  }
  const subCmd = typeof options.deviceCommand === 'string' ? options.deviceCommand.trim() : 'list';
  const validCmds = ANDROID_COMMANDS;
  const targetCmd = (subCmd === '' ? 'list' : subCmd) as (typeof validCmds)[number];
  if (!validCmds.includes(targetCmd)) {
    const msg = `Unknown device command '${subCmd}'. Use: ${validCmds.join(', ')}.`;
    if (options.json) console.log(JSON.stringify({ error: msg }));
    else console.error(msg);
    return 2;
  }

  const nonFlags = options.nonFlagArgs || [];
  const maxPositionals = ['install', 'reverse'].includes(targetCmd)
    ? 2
    : ['doctor', 'list', 'prune', 'build'].includes(targetCmd)
      ? 0
      : 1;
  const usageError = (msg: string) => {
    if (options.json) console.log(JSON.stringify({ error: msg }));
    else console.error(msg);
    return 2;
  };
  const globalOptions = ['help', 'json'];
  // reverse takes its port mapping through --port as well as a positional.
  const verbOptions: string[] = [...DEVICE_COMMAND_OPTIONS[targetCmd]];
  if (targetCmd === 'reverse') verbOptions.push('port');
  const supplied = Object.keys(options).filter(
    (key) =>
      key !== 'url' &&
      Object.hasOwn(possibleOptions, key) &&
      (options as Record<string, unknown>)[key] !== undefined,
  );
  // view hands every flag to the Electron viewer (--overlay, --design, ...), which owns that set.
  const unsupported = targetCmd !== 'view' && supplied.find(
    (key) => !globalOptions.includes(key) && !verbOptions.includes(key),
  );
  if (unsupported) {
    return usageError(
      `--${unsupported} is not valid for awrit device ${targetCmd}. Use: awrit device ${targetCmd} --help`,
    );
  }
  if (nonFlags.length > maxPositionals) {
    return usageError(
      `Unexpected argument: ${nonFlags[maxPositionals]}. Use: awrit device ${targetCmd} --help`,
    );
  }
  const deviceName = nonFlags[0];
  if (!deviceName && ['create', 'start', 'stop', 'delete'].includes(targetCmd)) {
    return usageError(`Name the device. Use: awrit device ${targetCmd} NAME`);
  }

  const extraArgs: Record<string, any> = {};
  if (nonFlags[1] && targetCmd === 'install') extraArgs.apk = nonFlags[1];
  if (nonFlags[1] && targetCmd === 'reverse') extraArgs.ports = nonFlags[1];
  if (options.port) {
    if (targetCmd === 'reverse') extraArgs.ports = String(options.port);
    else {
      const parsedPort = Number(options.port);
      if (!/^\d+$/.test(String(options.port)) || parsedPort < 1 || parsedPort > 65535) {
        return usageError(`Invalid --port '${String(options.port)}'. Use a number from 1 to 65535.`);
      }
      extraArgs.port = parsedPort;
    }
  }
  if (options.image) {
    extraArgs.image = String(options.image).trim();
  }
  if (options.api) {
    extraArgs.api = String(options.api).trim();
  }
  if (options.device) {
    extraArgs.deviceModel = String(options.device).trim();
  }
  if (options.force) {
    extraArgs.force = true;
  }
  if (options.yes) {
    extraArgs.yes = true;
  }
  if (options.resolution !== undefined) {
    const parsedResolution = parseResolution(options.resolution);
    if (!parsedResolution.ok) {
      return usageError(
        `Invalid --resolution '${String(options.resolution)}'. Use ${RESOLUTION_FORMAT}.`,
      );
    }
    extraArgs.resolution = parsedResolution.resolution;
  }
  if (options.out) {
    extraArgs.out = String(options.out).trim();
  }
  if (options.json) {
    extraArgs.json = true;
  }
  extraArgs.terminalProgress = !options.json && Boolean(process.stderr.isTTY);

  if (targetCmd === 'view' && deviceName && !extraArgs.json) return null;
  if (options['accept-license']) extraArgs.acceptLicense = true;
  if (options['tools-url']) extraArgs.toolsUrl = String(options['tools-url']).trim();
  if (options['tools-sha256']) extraArgs.toolsSha256 = String(options['tools-sha256']).trim();
  const res = await executeDeviceAction(targetCmd, deviceName, extraArgs);
  // Some failure paths return plain text even with --json; keep stdout valid JSON for scripts.
  console.log(
    options.json && !res.ok && !isJsonObjectMessage(res.message)
      ? JSON.stringify({ error: res.message })
      : res.message,
  );
  return res.ok ? 0 : 1;
}
