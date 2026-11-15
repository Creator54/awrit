import { expect, test } from 'bun:test';
import { parsePresentationArgs } from './args';
import { presentationHelp } from './help';

test('capture and snapshot help expose page-ready controls with a valid example', () => {
  for (const command of ['capture', 'snapshot'] as const) {
    const help = presentationHelp(command);
    expect(help).toContain('--wait-ms');
    expect(help).toContain('--wait-selector');
    const example = help.split('\n').find((line) => line.startsWith('Example: awrit '));
    expect(example).toBeDefined();
    const parsed = parsePresentationArgs(example?.replace('Example: awrit ', '').split(' ') ?? []);
    expect(parsed?.command).toBe(command);
    expect(parsed?.waitSelector).toBe('main');
  }
});

test('preview help exposes layout and sizing controls', () => {
  for (const command of ['show', 'inline'] as const) {
    const help = presentationHelp(command);
    for (const option of ['--width', '--height', '--layout', 'text-left', 'media-left']) {
      expect(help).toContain(option);
    }
  }
});
