export type Connection = 'secure' | 'insecure' | 'local';

/** Connection state shown by the address-bar lock. Non-web pages (awrit:, file:, about:) are local. */
export function connectionOf(url: string): Connection {
  try {
    const { protocol } = new URL(url);
    if (protocol === 'https:') return 'secure';
    if (protocol === 'http:') return 'insecure';
  } catch {}
  return 'local';
}

export const PERMISSION_LABELS: Record<string, string> = {
  media: 'Camera & microphone',
  geolocation: 'Location',
  notifications: 'Notifications',
};

export type PermissionChoice = 'ask' | 'allow' | 'block';

/** Stored value -> choice; media may be a comma list such as 'video,audio', which counts as allowed. */
export function permissionChoice(value: boolean | string | undefined): PermissionChoice {
  if (value === undefined) return 'ask';
  return value ? 'allow' : 'block';
}
