/** Attachment/viewport identity, not a stable device identity or authorization grant. */
export interface CaptureProvenance {
  session: string;
  generation: number;
  epoch: number;
}

export function parseCaptureProvenance(value: unknown): CaptureProvenance | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('Invalid capture provenance');
  const session: unknown = Reflect.get(value, 'session');
  const generation: unknown = Reflect.get(value, 'generation');
  const epoch: unknown = Reflect.get(value, 'epoch');
  if (
    typeof session !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(session) ||
    typeof generation !== 'number' ||
    !Number.isSafeInteger(generation) ||
    generation < 0 ||
    typeof epoch !== 'number' ||
    !Number.isSafeInteger(epoch) ||
    epoch < 0
  )
    throw new Error('Invalid capture provenance');
  return { session, generation, epoch };
}
