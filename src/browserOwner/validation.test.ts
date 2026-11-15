import { expect, test } from 'bun:test';
import { validInput, validSize } from './validation';

test('native control sequences and graphics acknowledgments do not disconnect panes', () => {
  expect(
    validInput({ eventType: 'escape', escape: { kind: 'osc', text: '10;rgb:ffff/ffff/ffff' } }),
  ).toBe(true);
  expect(validInput({ eventType: 'escape', escape: { kind: 'invalid', text: '' } })).toBe(false);
  expect(validInput({ eventType: 'graphics', graphics: { id: 'i=1,p=1', status: 'Ok' } })).toBe(
    true,
  );
  expect(
    validInput({
      eventType: 'key',
      keyEvent: { code: 'c', down: true, isCharEvent: true, modifiers: ['ctrl'] },
    }),
  ).toBe(true);
  expect(
    validInput({
      eventType: 'mouse',
      mouseEvent: { kind: 'mouseMove', x: 286, y: 635, modifiers: [] },
    }),
  ).toBe(true);
  expect(
    validInput({
      eventType: 'mouse',
      mouseEvent: { kind: 'mouseMove', x: -1, y: 2, modifiers: [], button: null },
    }),
  ).toBe(false);
  expect(validSize({ width: 800, height: 600, cols: 80, rows: 30 })).toBe(true);
  expect(validSize({ width: NaN, height: 600, cols: 80, rows: 30 })).toBe(false);
});
