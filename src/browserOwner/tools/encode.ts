import { encodeLines, type JsonValue } from '@toon-format/toon';

const MAX_OUTPUT_BYTES = 65536;
const MAX_INPUT_BYTES = 262144;

// Accept JSON data only: the encoder otherwise silently normalizes non-JSON values.
export function encodeToolResult(value: unknown, maxBytes = MAX_OUTPUT_BYTES): string {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_OUTPUT_BYTES)
    throw new Error('Invalid output byte limit');
  let nodes = 0;
  let inputBytes = 0;
  const ancestors = new Set<object>();
  const countString = (text: string) => {
    inputBytes += Buffer.byteLength(text);
    if (inputBytes > MAX_INPUT_BYTES) throw new Error('Input limit exceeded');
  };
  const copy = (item: unknown, depth: number): JsonValue => {
    if (++nodes > 10000 || depth > 32) throw new Error('Input limit exceeded');
    if (item === null || typeof item === 'boolean') return item;
    if (typeof item === 'string') {
      countString(item);
      return item;
    }
    if (typeof item === 'number' && Number.isFinite(item)) return item;
    if (typeof item !== 'object' || item === null) throw new Error('Expected JSON data');
    if (ancestors.has(item)) throw new Error('Cyclic JSON data');
    const array = Array.isArray(item);
    const prototype = Object.getPrototypeOf(item);
    if (!array && prototype !== Object.prototype && prototype !== null)
      throw new Error('Expected plain JSON data');
    ancestors.add(item);
    try {
      const keys = Object.keys(item);
      if (keys.length > 10000 || (array && item.length > 10000))
        throw new Error('Input limit exceeded');
      const entries: [string, JsonValue][] = [];
      for (const key of keys) {
        countString(key);
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !('value' in descriptor))
          throw new Error('Expected JSON data, not accessors');
        entries.push([key, copy(descriptor.value, depth + 1)]);
      }
      if (array) {
        if (entries.length !== item.length || entries.some(([key], i) => key !== String(i)))
          throw new Error('Expected dense JSON array');
        return entries.map(([, entry]) => entry);
      }
      return Object.fromEntries(entries);
    } finally {
      ancestors.delete(item);
    }
  };
  const data = copy(value, 0);
  const lines: string[] = [];
  let bytes = 0;
  for (const line of encodeLines(data)) {
    bytes += Buffer.byteLength(line) + (lines.length ? 1 : 0);
    if (bytes > maxBytes) throw new Error('Output byte limit exceeded');
    lines.push(line);
  }
  return lines.join('\n');
}
