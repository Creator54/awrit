import { expect, test } from 'bun:test';
import { requestRemoteFile } from './fileChooser';
import type { PendingFileChooser } from './owner';

test('request remains pending until installation finishes and does not repeat installation', async () => {
  let chooser: PendingFileChooser | undefined;
  let finish: () => void = () => {};
  const installing = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let settled = false;
  const result = requestRemoteFile(
    (value) => {
      chooser = value;
    },
    new AbortController().signal,
    () => installing,
  );
  void result.then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  if (!chooser) throw Error('No chooser');
  const installed = chooser.install('/verified/file');
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  await installed;
  expect(await result).toEqual({ canceled: true, filePaths: [] });
  await expect(chooser.install('/late')).rejects.toThrow('canceled');
});

test('document abort cancels the pending request and rejects a late installation', async () => {
  const controller = new AbortController();
  let chooser: PendingFileChooser | undefined;
  let installs = 0;
  const result = requestRemoteFile(
    (value) => {
      chooser = value;
    },
    controller.signal,
    async () => {
      installs++;
    },
  );
  controller.abort();
  expect((await result).canceled).toBe(true);
  if (!chooser) throw Error('No chooser');
  await expect(chooser.install('/late')).rejects.toThrow('canceled');
  expect(installs).toBe(0);
});
