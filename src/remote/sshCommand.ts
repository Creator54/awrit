export type RemoteChannel = 'control' | 'media' | 'bulk';

const ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,252}$/;
// ssh joins the command argv after the host with spaces for the remote login shell,
// so the path must be shell-inert rather than merely whitespace-free.
const RUNTIME_PATH_PATTERN = /^\/[A-Za-z0-9._/@+-]*$/;
/** Items ssh joins with spaces after the host, so incidental characters are not allowed. */
const ARGV_ITEM = /^[A-Za-z0-9._/@+-]+$/;

const SSH_OPTIONS = [
  '-T',
  '-o',
  'BatchMode=yes',
  '-o',
  'ControlMaster=no',
  '-o',
  'ControlPath=none',
  '-o',
  'Compression=no',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ServerAliveInterval=2',
  '-o',
  'ServerAliveCountMax=3',
];

export interface RemoteForward {
  /** Local loopback port the remote host reaches through this lane. */
  localPort: number;
  /** Remote loopback port; 0 lets sshd allocate one. */
  remotePort: number;
}

function validatePort(port: number, allowZero: boolean): number {
  if (!Number.isSafeInteger(port) || port < (allowZero ? 0 : 1) || port > 65535)
    throw new Error(`Invalid forwarded port: ${port}`);
  return port;
}

export function validateAlias(alias: string): string {
  if (!ALIAS_PATTERN.test(alias)) throw new Error(`Invalid ssh alias: ${JSON.stringify(alias)}`);
  return alias;
}

export function validateRuntimePath(runtimePath: string): string {
  const segments = runtimePath.split('/');
  if (!RUNTIME_PATH_PATTERN.test(runtimePath) || segments.includes('..'))
    throw new Error(`Invalid runtime path: ${JSON.stringify(runtimePath)}`);
  return runtimePath;
}

export function sshArgv(
  alias: string,
  channel: RemoteChannel,
  runtimePath: string,
  forward?: RemoteForward,
): string[] {
  if (forward !== undefined && channel !== 'control')
    throw new Error('Only the control lane can forward a port');
  return [
    ...SSH_OPTIONS,
    ...(forward === undefined
      ? []
      : [
          '-o',
          'ExitOnForwardFailure=yes',
          '-o',
          'LogLevel=INFO',
          '-R',
          `127.0.0.1:${validatePort(forward.remotePort, true)}:127.0.0.1:${validatePort(forward.localPort, false)}`,
        ]),
    '--',
    validateAlias(alias),
    validateRuntimePath(runtimePath),
    'remote-bridge',
    '--channel',
    channel,
  ];
}

/**
 * Fixed scripts go through `sh -s` with the script on stdin, so a fish or csh
 * login shell never parses them. `args` reach the script as $1, $2 and must
 * already be validated by the caller.
 */
export function sshScriptArgv(alias: string, args: string[] = []): string[] {
  if (!args.every((item) => ARGV_ITEM.test(item)))
    throw new Error(`Invalid script argument: ${JSON.stringify(args).slice(0, 80)}`);
  return [...SSH_OPTIONS, '--', validateAlias(alias), 'sh', '-s', '--', ...args];
}

/** One ssh connection that runs a plain command with data on its stdin. */
export function sshCommandArgv(alias: string, argv: string[]): string[] {
  if (argv.length === 0 || !argv.every((item) => ARGV_ITEM.test(item)))
    throw new Error(`Invalid remote command: ${JSON.stringify(argv).slice(0, 80)}`);
  return [...SSH_OPTIONS, '--', validateAlias(alias), ...argv];
}
