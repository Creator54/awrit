import type { TermEvent, WindowSize } from 'awrit-native-rs';

export function validSize(value: unknown): value is WindowSize {
  if (!value || typeof value !== 'object') return false;
  return ['width', 'height', 'cols', 'rows'].every(
    (key) => key in value && validInteger(Reflect.get(value, key), 1, 65535),
  );
}
function validInteger(value: unknown, low: number, high: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= low && value <= high;
}
export function validInput(value: unknown): value is TermEvent {
  if (!value || typeof value !== 'object' || !('eventType' in value)) return false;
  if (value.eventType === 'key' && 'keyEvent' in value) {
    const key = value.keyEvent;
    return (
      !!key &&
      typeof key === 'object' &&
      'code' in key &&
      typeof key.code === 'string' &&
      key.code.length < 64 &&
      'modifiers' in key &&
      Array.isArray(key.modifiers) &&
      key.modifiers.length < 16 &&
      key.modifiers.every((m) => typeof m === 'string' && m.length < 32) &&
      'down' in key &&
      typeof key.down === 'boolean' &&
      'isCharEvent' in key &&
      typeof key.isCharEvent === 'boolean'
    );
  }
  if (value.eventType === 'graphics' && 'graphics' in value) {
    const g = value.graphics;
    return (
      !!g &&
      typeof g === 'object' &&
      'id' in g &&
      typeof g.id === 'string' &&
      g.id.length < 256 &&
      'status' in g &&
      typeof g.status === 'string' &&
      g.status.length < 1024
    );
  }
  if (value.eventType === 'escape' && 'escape' in value) {
    const sequence = value.escape;
    return (
      !!sequence &&
      typeof sequence === 'object' &&
      'kind' in sequence &&
      typeof sequence.kind === 'string' &&
      ['osc', 'apc', 'dcs', 'pm'].includes(sequence.kind) &&
      'text' in sequence &&
      typeof sequence.text === 'string' &&
      sequence.text.length <= 60000
    );
  }
  if (value.eventType === 'paste')
    return 'paste' in value && typeof value.paste === 'string' && value.paste.length <= 60000;
  if (value.eventType === 'focus')
    return (
      ('focusGained' in value && typeof value.focusGained === 'boolean') ||
      ('focusLost' in value && typeof value.focusLost === 'boolean')
    );
  if (value.eventType === 'mouse' && 'mouseEvent' in value) {
    const mouse = value.mouseEvent;
    return (
      !!mouse &&
      typeof mouse === 'object' &&
      'kind' in mouse &&
      typeof mouse.kind === 'string' &&
      [
        'mouseDown',
        'mouseUp',
        'mouseMove',
        'scrollUp',
        'scrollDown',
        'scrollLeft',
        'scrollRight',
      ].includes(mouse.kind) &&
      'x' in mouse &&
      validInteger(mouse.x, 0, 65535) &&
      'y' in mouse &&
      validInteger(mouse.y, 0, 65535) &&
      'modifiers' in mouse &&
      Array.isArray(mouse.modifiers) &&
      mouse.modifiers.every((m) => typeof m === 'string') &&
      (!('button' in mouse) ||
        mouse.button === null ||
        mouse.button === undefined ||
        ['left', 'middle', 'right', 'fourth', 'fifth'].includes(String(mouse.button)))
    );
  }
  return false;
}
