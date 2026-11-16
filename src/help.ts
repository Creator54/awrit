import { ANDROID_COMMANDS, DEVICE_COMMAND_OPTIONS } from './adb/androidCli';
import { type Option, options, type ParsedOptions, possibleOptions } from './args';

const DEVICE_GROUPS: [string, string, string][] = [
  ['Devices', 'list', 'List managed and connected devices'],
  ['Devices', 'show NAME', 'Show one device in detail'],
  ['Devices', 'create NAME', 'Create a managed device'],
  ['Devices', 'start NAME', 'Start a device'],
  ['Devices', 'stop NAME', 'Stop a device'],
  ['Devices', 'delete NAME', 'Delete a device'],
  ['Devices', 'prune', 'Remove stopped devices'],
  ['Look', 'view NAME|SERIAL', 'Open the live device screen'],
  ['Look', 'screenshot NAME --out FILE', 'Save a device screenshot'],
  ['Apps', 'install NAME APK', 'Install an APK'],
  ['Apps', 'reverse NAME PORT[:PORT]', 'Forward a device port'],
  ['Apps', 'logcat NAME', 'Show device logs'],
  ['Setup', 'doctor', 'Check KVM, Podman and memory'],
  ['Setup', 'build', 'Build an SDK-only emulator image'],
];


export function showHelp(opts: ParsedOptions = options): void {
  const command = ANDROID_COMMANDS.find((value) => value === opts.deviceCommand);
  const device = opts.deviceCommand !== undefined;
  const groups: [string, Option[]][] = [];
  let usage = 'awrit [options] [url]\n       awrit device VERB [NAME] [options]';
  let footer = [
    'Examples:',
    '  awrit https://example.com',
    '  awrit device create phone    Then: awrit device start phone, awrit device view phone',
    '',
    'Commands: device, status, setup, show, capture, overlay, inline, snapshot, video, capabilities, context, tool',
    'More: awrit COMMAND --help, awrit --dev --help',
    '',
  ].join('\n');

  if (device) {
    usage = `awrit device ${command ?? 'VERB'} [NAME] [options]`;
    const overviewOptions: Option[] = [
      'api',
      'image',
      'device',
      'resolution',
      'port',
      'force',
      'out',
    ];
    groups.push([
      'Options',
      ['help', 'json', ...(command ? DEVICE_COMMAND_OPTIONS[command] : overviewOptions)],
    ]);
    if (command) {
      footer = 'More: awrit device --help\n';
    } else {
      const lines = ['Commands:'];
      let title = '';
      for (const [group, verb, description] of DEVICE_GROUPS) {
        if (group !== title) {
          title = group;
          lines.push(`  ${group}:`);
        }
        lines.push(`    ${verb}  ${description}`);
      }
      footer = `${lines.join('\n')}\n\nUse awrit device VERB --help for command options.\n`;
    }
    if (command && ['create', 'start', 'stop', 'delete'].includes(command)) {
      usage = `awrit device ${command} NAME [options]`;
    }
    if (command === 'view') usage = 'awrit device view NAME|SERIAL [options]';
    if (command === 'install') usage = 'awrit device install NAME APK [options]';
    if (command === 'reverse') usage = 'awrit device reverse NAME PORT[:PORT] [options]';
    if (command === 'build' || command === 'doctor' || command === 'list') {
      usage = `awrit device ${command} [options]`;
    }
    if (command === 'build')
      footer =
        'Builds an SDK-only base image. It cannot run Android. For AOSP 13: podman build -f containers/android-aosp/Containerfile -t localhost/awrit-android-aosp:latest containers/android-aosp\n';
    if (command === 'create')
      footer =
        'Default: pinned Google APIs Android 13.\nAOSP 13: --image=localhost/awrit-android-aosp:latest (build locally first; see `awrit device build --help`).\n';
  } else if (opts.dev) {
    groups.push([
      'Development',
      [
        'help',
        'dev',
        'rebuild',
        'no-paint',
        'debug-paint',
        'transparent',
        'design',
        'debug-port',
      ],
    ]);
    footer = 'More: awrit --help, awrit device --help\n';
  } else {
    groups.push(['Options', ['help', 'pick', 'version', 'url']]);
  }

  process.stdout.write(`\x1b[0mUsage: ${usage}\n\n`);
  for (const [title, keys] of groups) {
    process.stdout.write(`${title}:\n`);
    const rows = keys.map((key) => {
      const option = possibleOptions[key];
      const argument = 'arg' in option ? `=${option.arg === true ? 'URL' : option.arg}` : '';
      const flag = option.short
        ? `-${option.short}, --${key}${argument}`
        : `--${key}${argument}`;
      return [flag, option.description] as const;
    });
    const width = Math.max(...rows.map(([flag]) => flag.length));
    for (const [flag, description] of rows) {
      process.stdout.write(`  ${flag.padEnd(width)}  ${description}\n`);
    }
    process.stdout.write('\n');
  }
  process.stdout.write(footer);
}
