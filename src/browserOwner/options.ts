import { parseArgs } from '../args';

import { parseCompanionConfig, type CompanionConfig } from '../presentation/companion';

export interface AndroidLaunch {
  target?: string;
  maxSize?: number;
  bitrate?: string;
}

export function decodeAndroidLaunch(value: unknown): AndroidLaunch {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid Android launch');
  const allowed = ['target', 'maxSize', 'bitrate'];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Invalid Android launch');
  const target = Reflect.get(value, 'target');
  const maxSize = Reflect.get(value, 'maxSize');
  const bitrate = Reflect.get(value, 'bitrate');
  if (
    target !== undefined &&
    (typeof target !== 'string' || !target.trim() || target.length > 4096)
  )
    throw new Error('Invalid Android target');
  if (
    maxSize !== undefined &&
    (typeof maxSize !== 'number' ||
      !Number.isSafeInteger(maxSize) ||
      maxSize < 1 ||
      maxSize > 65535)
  )
    throw new Error('Invalid Android size');
  if (
    bitrate !== undefined &&
    (typeof bitrate !== 'string' || !/^[1-9][0-9]{0,8}[kKmMgG]?$/.test(bitrate))
  )
    throw new Error('Invalid Android bitrate');
  return {
    ...(target !== undefined ? { target } : {}),
    ...(maxSize !== undefined ? { maxSize } : {}),
    ...(bitrate !== undefined ? { bitrate } : {}),
  };
}

export function decodeCompanionLaunch(value: unknown): CompanionConfig {
  if (typeof value !== 'string') throw new Error('Invalid companion config payload');
  return parseCompanionConfig(value);
}

export interface PaneSettings {
  overlay: boolean;
  design: boolean;
  transparent: boolean;
  noPaint: boolean;
  debugPaint: boolean;
}

export function normalizePaneLaunch(argv: string[], cwd: string) {
  const options = parseArgs(argv, cwd);
  const androidMode =
    options.deviceCommand === 'view' || /^awrit:\/\/adb(?:\/|$)/.test(options.url ?? '');
  const target =
    options.deviceCommand === 'view'
      ? options.nonFlagArgs?.[0]
      : options.url?.startsWith('awrit://adb')
        ? options.url.replace(/^awrit:\/\/adb\/?/, '').trim()
        : undefined;
  const android = androidMode
    ? decodeAndroidLaunch({
        ...(target ? { target } : {}),
        ...(options['max-size'] !== undefined ? { maxSize: Number(options['max-size']) } : {}),
        ...(options.bitrate !== undefined ? { bitrate: options.bitrate } : {}),
      })
    : undefined;
  const companion =
    options['presentation-json'] !== undefined
      ? decodeCompanionLaunch(options['presentation-json'])
      : undefined;
  return {
    android,
    companion,
    url: options.url,
    sourceWindowId: options['source-window-id'],
    debugPort: normalizeDebugPort(options['debug-port'] ?? 'disabled'),
    settings: {
      overlay: Boolean(options.overlay),
      design: Boolean(options.design),
      transparent: Boolean(options.transparent),
      noPaint: Boolean(options['no-paint']),
      debugPaint: Boolean(options['debug-paint']),
    } satisfies PaneSettings,
  };
}

export function normalizeDebugPort(value: string): string {
  if (value === '0' || value === 'disabled') return 'disabled';
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535)
    throw new Error('Invalid remote debugging port');
  return String(Number(value));
}

export function decodePaneSettings(value: unknown): PaneSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid pane settings');
  const keys = ['overlay', 'design', 'transparent', 'noPaint', 'debugPaint'];
  if (
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key) || typeof Reflect.get(value, key) !== 'boolean')
  )
    throw new Error('Invalid pane settings');
  // Exact keys and boolean values validated above.
  return value as PaneSettings;
}
