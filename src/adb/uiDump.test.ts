import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUiDumper } from './uiDump';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A fake adb: the helper invocation (it mentions app_process) runs `helper`, anything else
// is the stock dump and prints STOCK.
function fakeAdb(helper: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'awrit-uidump-'));
  dirs.push(dir);
  const file = path.join(dir, 'adb');
  writeFileSync(
    file,
    `#!/bin/sh\ncase "$*" in *app_process*) ${helper} ;; *) echo STOCK ;; esac\n`,
  );
  chmodSync(file, 0o755);
  return file;
}

describe('createUiDumper', () => {
  test('answers from the resident helper without respawning it', async () => {
    const adb = fakeAdb(
      'echo ready; while read -r _; do echo "<hierarchy/>"; printf "\\001END\\n"; done',
    );
    const dumper = createUiDumper(adb, 'dev', new AbortController().signal);
    expect(await dumper.dump()).toBe('<hierarchy/>\n');
    expect(await dumper.dump()).toBe('<hierarchy/>\n');
    dumper.close();
  });

  test('falls back to the stock dump when the helper cannot start', async () => {
    const dumper = createUiDumper(fakeAdb('exit 1'), 'dev', new AbortController().signal);
    expect((await dumper.dump()).trim()).toBe('STOCK');
    dumper.close();
  });
});
