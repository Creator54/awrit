import type { SupportedFeatures, WindowSize } from 'awrit-native-rs';
import {
  normalizeDebugPort,
  decodePaneSettings,
  decodeAndroidLaunch,
  type AndroidLaunch,
  type PaneSettings,
} from './options';
import type { CompanionConfig } from '../presentation/companion';
import { parseCompanionConfig } from '../presentation/companion';

export interface AttachRequest {
  type: 'attach';
  version: 1;
  build: string;
  debugPort: string;
  url: string;
  profile?: string;
  android?: AndroidLaunch;
  companion?: CompanionConfig;
  sourceWindowId?: string;
  kittyWindowId?: string;
  terminalScheme?: 'light' | 'dark';
  terminalBackground?: string;
  size: WindowSize;
  features: SupportedFeatures;
  settings: PaneSettings;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid attach object');
  return Object.fromEntries(Object.entries(value));
}

function exact(value: Record<string, unknown>, keys: string[]): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key)))
    throw new Error('Unexpected attach fields');
}

export function decodeAttach(value: unknown, build: string, debugPort = 'disabled'): AttachRequest {
  const request = record(value);
  const optional = ['sourceWindowId', 'kittyWindowId', 'profile', 'android', 'companion', 'terminalScheme', 'terminalBackground'].filter(
    (key) => Object.hasOwn(request, key),
  );
  exact(request, [
    'type',
    'version',
    'build',
    'debugPort',
    'url',
    'size',
    'features',
    'settings',
    ...optional,
  ]);
  if (typeof request.debugPort !== 'string' || normalizeDebugPort(request.debugPort) !== debugPort)
    throw new Error('Incompatible owner debugging port; close existing viewers first');
  if (
    request.profile !== undefined &&
    (typeof request.profile !== 'string' ||
      !request.profile.startsWith('/') ||
      request.profile.length > 4096)
  )
    throw new Error('Invalid profile identity');
  if (Object.hasOwn(request, 'android')) decodeAndroidLaunch(request.android);
  if (Object.hasOwn(request, 'companion')) {
    if (!request.companion || typeof request.companion !== 'object')
      throw new Error('Invalid companion config');
    parseCompanionConfig(JSON.stringify(request.companion));
  }
  if (request.terminalScheme !== undefined && request.terminalScheme !== 'light' && request.terminalScheme !== 'dark')
    throw new Error('Invalid terminal color scheme');
  if (request.terminalBackground !== undefined && (typeof request.terminalBackground !== 'string' || !/^#[0-9a-f]{6}$/.test(request.terminalBackground)))
    throw new Error('Invalid terminal background');
  for (const key of optional.filter(
    (key) => key !== 'profile' && key !== 'android' && key !== 'companion' && key !== 'terminalScheme' && key !== 'terminalBackground',
  )) {
    if (typeof request[key] !== 'string' || !/^[0-9]{1,20}$/.test(request[key]))
      throw new Error('Invalid terminal window identity');
  }
  if (request.type !== 'attach' || request.version !== 1 || request.build !== build)
    throw new Error('Incompatible Awrit owner; close old viewers and retry');
  if (typeof request.url !== 'string' || request.url.length > 32768)
    throw new Error('Invalid attach URL');
  decodePaneSettings(request.settings);
  const size = record(request.size);
  exact(size, ['width', 'height', 'cols', 'rows']);
  for (const dimension of Object.values(size)) {
    if (
      typeof dimension !== 'number' ||
      !Number.isSafeInteger(dimension) ||
      dimension < 1 ||
      dimension > 65535
    )
      throw new Error('Invalid attach dimensions');
  }
  const features = record(request.features);
  exact(features, ['keyboard', 'images', 'loadFrame', 'compositeFrame']);
  if (Object.values(features).some((feature) => typeof feature !== 'boolean'))
    throw new Error('Invalid attach features');
  // Every field in this boundary type was checked above, including exact nested keys.
  return value as AttachRequest;
}
