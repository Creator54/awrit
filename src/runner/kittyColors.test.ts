import { expect, spyOn, test } from 'bun:test';
import { colorsToTailwind, queryColors, terminalBackground, terminalScheme } from './kittyColors';

test('Design scheme follows terminal background without baking it into shared assets', () => {
  expect(terminalScheme([['kitty-bg', '#ffffff']])).toBe('light');
  expect(terminalScheme([['kitty-bg', '#181818']])).toBe('dark');
  expect(terminalScheme([['kitty-bg', '#ffffffffffff']])).toBe('light');
  expect(terminalScheme([])).toBe('dark');
  expect(colorsToTailwind([['kitty-bg', '#ffffff']])).not.toContain('--awrit-terminal-scheme');
});

test('successful colour query leaves no delayed stdin cleanup', async () => {
  const rawDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, writable: true, value: () => process.stdin });
  const raw = spyOn(process.stdin, 'setRawMode').mockImplementation(() => process.stdin);
  const resume = spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin);
  const pause = spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin);
  const encoding = spyOn(process.stdin, 'setEncoding').mockImplementation(() => process.stdin);
  const output = spyOn(process.stdout, 'write').mockImplementation(() => true);
  try {
    const result = queryColors();
    process.stdin.emit('data', '\x1b]21;background=rgb:1d/20/21\x1b\\');
    process.stdin.emit('data', '\x1b]10;rgb:eb/db/b2\x1b\\\x1b]11;rgb:1d/20/21\x1b\\');
    expect(await result).toEqual([['kitty-bg', '#1d2021'], ['kitty-fg', '#ebdbb2']]);
    expect(pause).toHaveBeenCalledTimes(1);
    await Bun.sleep(130);
    expect(pause).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledTimes(2);
  } finally {
    for (const mock of [raw, resume, pause, encoding, output]) mock.mockRestore();
    if (rawDescriptor) Object.defineProperty(process.stdin, 'setRawMode', rawDescriptor);
    else Reflect.deleteProperty(process.stdin, 'setRawMode');
  }
});

test('a terminal without OSC 21, such as TUIOS, still gives its colours through OSC 10/11', async () => {
  const rawDescriptor = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, writable: true, value: () => process.stdin });
  const mocks = [
    spyOn(process.stdin, 'setRawMode').mockImplementation(() => process.stdin),
    spyOn(process.stdin, 'resume').mockImplementation(() => process.stdin),
    spyOn(process.stdin, 'pause').mockImplementation(() => process.stdin),
    spyOn(process.stdin, 'setEncoding').mockImplementation(() => process.stdin),
    spyOn(process.stdout, 'write').mockImplementation(() => true),
  ];
  try {
    const result = queryColors();
    process.stdin.emit('data', '\x1b]10;rgb:ebeb/dbdb/b2b2\x07\x1b]11;rgb:1d1d/2020/2121\x07');
    const colors = await result;
    expect(colors).toEqual([['kitty-fg', '#ebdbb2'], ['kitty-bg', '#1d2021']]);
    expect(terminalBackground(colors ?? [])).toBe('#1d2021');
  } finally {
    for (const mock of mocks) mock.mockRestore();
    if (rawDescriptor) Object.defineProperty(process.stdin, 'setRawMode', rawDescriptor);
    else Reflect.deleteProperty(process.stdin, 'setRawMode');
  }
});

test('terminal background is normalized to #rrggbb for backing fills', () => {
  expect(terminalBackground([['kitty-bg', '#1D2021']])).toBe('#1d2021');
  expect(terminalBackground([['kitty-bg', '#1d1d20202121']])).toBe('#1d2021');
  expect(terminalBackground([['kitty-bg', '#fff']])).toBeUndefined();
  expect(terminalBackground([])).toBeUndefined();
});
