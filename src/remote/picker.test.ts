import { expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createUploadChooser, parsePickedFile, uploadPickerCommand } from './picker';

test('picker launches isolated local entry without shell interpolation or owner flags', () => {
  expect(
    uploadPickerCommand(
      'phoenix',
      {
        AWRIT_ELECTRON: '/runtime/electron',
        AWRIT_OWNER_ENTRY: '/runtime/dist/browserOwner/main.js',
      },
      '/ignored',
    ),
  ).toEqual({
    command: '/runtime/electron',
    args: ['/runtime/dist/remote/pickerMain.js', 'phoenix'],
  });
  expect(() => uploadPickerCommand('host;evil', { AWRIT_ELECTRON: 'electron' }, '/cli')).toThrow();
  expect(() => uploadPickerCommand('host', {}, '/cli')).toThrow();
});
test('only one absolute local chosen path is accepted; empty response means cancel', () => {
  expect(parsePickedFile('')).toBeUndefined();
  expect(parsePickedFile(JSON.stringify({ file: '/local/chosen.txt' }))).toBe('/local/chosen.txt');
  for (const value of [
    { file: 'relative' },
    { file: '/ok', extra: true },
    [],
    null,
    { file: '/bad\0path' },
  ])
    expect(() => parsePickedFile(JSON.stringify(value))).toThrow();
});

const PICKER_ENV: NodeJS.ProcessEnv = {
  AWRIT_ELECTRON: '/runtime/electron',
  AWRIT_OWNER_ENTRY: '/runtime/dist/browserOwner/main.js',
};

/** A child_process stand-in: writes `stdout`, then closes, unless told to wait for a kill. */
function fakeSpawn(
  stdout: string,
  options: { closeImmediately?: boolean; exitOnKill?: boolean; error?: Error } = {},
) {
  const argv: string[][] = [];
  const kills: string[] = [];
  const spawn = ((command: string, args: readonly string[]) => {
    argv.push([command, ...args]);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill(signal?: string) {
        kills.push(signal ?? 'SIGTERM');
        if (options.exitOnKill)
          setImmediate(() => {
            child.emit('close', null);
            closed();
          });
        return true;
      },
    });
    const closed = child.stderr.destroy.bind(child.stderr);
    if (options.error) setImmediate(() => child.emit('error', options.error));
    else if (options.closeImmediately !== false) {
      child.stdout.write(stdout);
      child.stdout.end();
      child.stdout.once('end', () => {
        child.emit('close', 0);
        closed();
      });
    }
    return child;
  }) as unknown as typeof import('node:child_process').spawn;
  return { spawn, argv, kills };
}

test('ssh alias characters the command allows are accepted, including @', async () => {
  const cmd = uploadPickerCommand('host-2_@pool', PICKER_ENV, '/cli');
  expect(cmd.args[cmd.args.length - 1]).toBe('host-2_@pool');
  const fake = fakeSpawn('');
  const chooser = createUploadChooser(PICKER_ENV, fake.spawn);
  await chooser?.('me@box', new AbortController().signal);
  expect(fake.argv).toEqual([
    ['/runtime/electron', '/runtime/dist/remote/pickerMain.js', 'me@box'],
  ]);
});

test('a picker that crashes instead of cancelling is reported, never treated as consent', async () => {
  const fake = fakeSpawn('Error: could not open a display');
  const chooser = createUploadChooser(PICKER_ENV, fake.spawn);
  await expect(chooser?.('phoenix', new AbortController().signal)).rejects.toThrow(
    'Invalid local picker result',
  );
});

test('the chooser does not exist without a local Electron runtime', () => {
  expect(createUploadChooser({})).toBeUndefined();
});

test('an approved pick resolves to an open source with the mime of its extension', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'awrit-picker-test-'));
  try {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['picked.png', 'image/png'],
      ['picked.jpg', 'image/jpeg'],
      ['picked.jpeg', 'image/jpeg'],
      ['picked.gif', 'image/gif'],
      ['picked.webp', 'image/webp'],
      ['picked.json', 'application/json'],
      ['picked.txt', 'text/plain'],
    ];
    for (const [name, mime] of cases) {
      const file = path.join(dir, name);
      await fs.writeFile(file, 'chosen bytes');
      const fake = fakeSpawn(JSON.stringify({ file }));
      const chooser = createUploadChooser(PICKER_ENV, fake.spawn);
      const chosen = await chooser?.('phoenix', new AbortController().signal);
      expect(chosen?.mime).toBe(mime);
      expect(chosen?.source.metadata.name).toBe(name);
      const sent: Buffer[] = [];
      for await (const chunk of chosen?.source.chunks() ?? []) sent.push(Buffer.from(chunk));
      expect(Buffer.concat(sent).toString()).toBe('chosen bytes');
      await chosen?.source.close();
      expect(fake.argv).toEqual([
        ['/runtime/electron', '/runtime/dist/remote/pickerMain.js', 'phoenix'],
      ]);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('a spawn failure rejects instead of hanging', async () => {
  const fake = fakeSpawn('', { error: new Error('spawn ENOENT') });
  const chooser = createUploadChooser(PICKER_ENV, fake.spawn);
  await expect(chooser?.('phoenix', new AbortController().signal)).rejects.toThrow('spawn ENOENT');
});

test('an empty picker response means the user cancelled', async () => {
  const fake = fakeSpawn('');
  const chooser = createUploadChooser(PICKER_ENV, fake.spawn);
  await expect(chooser?.('phoenix', new AbortController().signal)).resolves.toBeUndefined();
});

test('unparseable picker output is refused', async () => {
  const fake = fakeSpawn('{not json');
  const chooser = createUploadChooser(PICKER_ENV, fake.spawn);
  await expect(chooser?.('phoenix', new AbortController().signal)).rejects.toThrow();
});

test('a picker result that is not one absolute path is refused', async () => {
  const fake = fakeSpawn(JSON.stringify({ file: 'relative.txt' }));
  const chooser = createUploadChooser(PICKER_ENV, fake.spawn);
  await expect(chooser?.('phoenix', new AbortController().signal)).rejects.toThrow(
    'Invalid local picker result',
  );
});

test('a file outside the allowed mime set is refused before any offer', async () => {
  const file = path.join(os.tmpdir(), 'awrit-picker-test-unknown.heic');
  const fake = fakeSpawn(JSON.stringify({ file }));
  const chooser = createUploadChooser(PICKER_ENV, fake.spawn);
  await expect(chooser?.('phoenix', new AbortController().signal)).rejects.toThrow(
    'Unsupported file type',
  );
});

test('aborting mid-flight kills the dialog process and resolves as a cancel', async () => {
  const fake = fakeSpawn('', { closeImmediately: false, exitOnKill: true });
  const chooser = createUploadChooser(PICKER_ENV, fake.spawn);
  const controller = new AbortController();
  const pending = chooser?.('phoenix', controller.signal);
  controller.abort();
  await expect(pending).resolves.toBeUndefined();
  expect(fake.kills).toEqual(['SIGTERM']);
});

test('an already aborted request spawns nothing', async () => {
  const fake = fakeSpawn('');
  const controller = new AbortController();
  controller.abort();
  const chooser = createUploadChooser(PICKER_ENV, fake.spawn);
  await expect(chooser?.('phoenix', controller.signal)).resolves.toBeUndefined();
  expect(fake.argv).toEqual([]);
});

test('ssh alias characters the command allows are accepted, including @', () => {
  const env = { AWRIT_ELECTRON: '/usr/bin/electron' };
  const cmd = uploadPickerCommand('host-2_@pool', env, '/usr/bin/awrit');
  expect(cmd.args[cmd.args.length - 1]).toBe('host-2_@pool');
});
