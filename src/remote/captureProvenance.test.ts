import { expect, test } from 'bun:test';
import { parseCaptureProvenance } from './captureProvenance';

test('accepts legacy absence and validated attachment identity', () => {
  expect(parseCaptureProvenance(undefined)).toBeUndefined();
  expect(parseCaptureProvenance({ session: 'pane_1', generation: 2, epoch: 0 })).toEqual({
    session: 'pane_1',
    generation: 2,
    epoch: 0,
  });
});

test('rejects malformed attachment identity', () => {
  for (const value of [
    null,
    {},
    { session: '../foreign', generation: 0, epoch: 0 },
    { session: 's', generation: -1, epoch: 0 },
    { session: 's', generation: 1, epoch: 0.5 },
  ]) {
    expect(() => parseCaptureProvenance(value)).toThrow('Invalid capture provenance');
  }
});
