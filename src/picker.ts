import { spawnSync } from 'node:child_process';
import { findBinary } from './adb/adbControl';
import { LOCAL_AOSP_IMAGE, listConnectedAdbDevices, loadRegistry } from './adb/androidManager';

export interface SelectManyOptions {
  /** Start with every row selected (install flows only; never for destructive choices). */
  preselectAll?: boolean;
}

export function fzfArgs(
  prompt: string,
  custom: boolean,
  multi: boolean,
  preselectAll = false,
  choicesCount = 10,
): string[] {
  const header = multi
    ? `${preselectAll ? 'All selected · ' : ''}Tab: toggle · ctrl-a: all · ctrl-d: none · Enter: confirm · Esc: cancel`
    : custom
      ? 'Enter: choose a match or use unmatched text · Esc: cancel'
      : 'Enter: choose · Esc: cancel';
  const height = Math.min(Math.max(choicesCount + 4, 6), 25);
  return [
    `--height=~${height}`,
    '--layout=reverse',
    '--border',
    `--prompt=${prompt}> `,
    `--header=${header}`,
    ...(custom ? ['--print-query'] : []),
    ...(multi
      ? [
          '--multi',
          '--marker=✓ ',
          '--pointer=▶ ',
          '--bind=ctrl-a:select-all,ctrl-d:deselect-all,ctrl-t:toggle-all',
        ]
      : ['--pointer=▶ ']),
    ...(multi && preselectAll ? ['--bind=load:select-all'] : []),
  ];
}

function fzf(
  prompt: string,
  choices: string[],
  custom: boolean,
  multi: boolean,
  preselectAll = false,
): string[] | null {
  if (!custom && choices.length === 0) throw new Error(`No choices available for ${prompt}`);
  const result = spawnSync('fzf', fzfArgs(prompt, custom, multi, preselectAll, choices.length), {
    input: choices.join('\n'),
    encoding: 'utf8',
    env: process.env,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  if (result.error) throw new Error(`Cannot run fzf: ${result.error.message}`);
  const lines = result.stdout.trim().split('\n');
  if (custom && result.status === 1) return lines[0] ? [lines[0]] : null;
  if (result.status === 130) return null;
  if (result.status !== 0) throw new Error(`fzf exited with status ${result.status}`);
  const picked = multi ? lines.filter(Boolean) : lines.slice(-1).filter(Boolean);
  return picked.length > 0 ? picked : null;
}

export function select(prompt: string, choices: string[], custom = false): string | null {
  return fzf(prompt, choices, custom, false)?.[0] ?? null;
}

/** Multi-select via fzf Tab; null when cancelled or nothing chosen. */
export function selectMany(
  prompt: string,
  choices: string[],
  options: SelectManyOptions = {},
): string[] | null {
  return fzf(prompt, choices, false, true, options.preselectAll);
}

const DEVICE_ACTIONS = [
  'start',
  'view',
  'stop',
  'screenshot',
  'install',
  'logcat',
  'reverse',
  'delete',
] as const;
const NEW_DEVICE = 'New device';
const DOCTOR = 'Doctor: check setup';

function adbPath(): string {
  return findBinary('adb');
}

function createArgs(): string[] | null {
  const name = select('New VM name', [], true);
  if (!name) return null;
  const image = select('Image', ['Google APIs (default: 13)', 'AOSP 13 (local build)']);
  if (!image) return null;
  if (image === 'AOSP 13 (local build)') {
    return ['device', 'create', name, `--image=${LOCAL_AOSP_IMAGE}`];
  }
  const version = select('Android version', ['Default: pinned Android 13'], true);
  if (!version) return null;
  return [
    'device',
    'create',
    name,
    ...(version.startsWith('Default:') ? [] : [`--api=${version}`]),
  ];
}

async function deviceArgs(name: string): Promise<string[] | null> {
  const command = select(`Action for ${name}`, [...DEVICE_ACTIONS]);
  if (!command) return null;
  if (command === 'delete' && select(`Delete ${name}?`, ['Cancel', 'Delete']) !== 'Delete')
    return null;
  const args = ['device', command, name];
  // The confirmation above is the prompt; the CLI itself needs the flag in non-interactive runs.
  if (command === 'delete') args.push('--force');
  if (command === 'screenshot') {
    const file = select('Screenshot path', ['screenshot.png'], true);
    return file ? [...args, '--out', file] : null;
  }
  if (command === 'install' || command === 'reverse') {
    const value = select(
      command === 'install' ? 'APK path' : 'Port mapping',
      command === 'install' ? [] : ['8080:8080'],
      true,
    );
    return value ? [...args, value] : null;
  }
  return args;
}

async function androidArgs(): Promise<string[] | null> {
  const devices = Object.keys(loadRegistry().devices);
  const choice = select('Android devices', [...devices, NEW_DEVICE, DOCTOR]);
  if (!choice) return null;
  if (choice === DOCTOR) return ['device', 'doctor'];
  if (choice === NEW_DEVICE) return createArgs();
  return deviceArgs(choice);
}

export async function pickArgs(): Promise<string[] | null> {
  const action = select('Awrit', [
    'Browser: open URL',
    'Android',
    'Phone: view connected device',
    'Help',
  ]);
  if (!action) return null;
  if (action === 'Help') return ['--help'];
  if (action === 'Android') return androidArgs();
  if (action === 'Browser: open URL') {
    const url = select('URL or domain', ['https://example.com', 'http://localhost:3000'], true);
    return url ? ['--url', url] : null;
  }
  const serial = select('Connected device', await listConnectedAdbDevices(adbPath()));
  return serial ? ['device', 'view', serial] : null;
}
