import { test, expect } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

test('owner respects disabled Ctrl+C quit and consumed copy input', () => {
  const source = fs.readFileSync(path.join(import.meta.dir, 'paneSession.ts'), 'utf8');
  const start = source.indexOf("if (!handle?.handleInput(msg.event)");
  const end = source.indexOf("} else handle?.handleInput", start);
  expect(start).toBeGreaterThan(0);
  const code = source.slice(start, end);
  for (const quit of [true, false, undefined]) {
    for (const consumed of [true, false]) {
      let ended = false;
      vm.runInNewContext(code, {
        handle: { handleInput: () => consumed }, msg: { event: {} },
        getConfig: () => ({ kitty: { quitOnCtrlC: quit } }),
        socket: { end: () => { ended = true; } },
      });
      expect(ended).toBe(!consumed && quit !== false);
    }
  }
});

test('owner reloads config after invalid and atomic edits and stops watching', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awrit-config-')));
  try {
    const build = await Bun.build({
      entrypoints: [path.join(import.meta.dir, 'config.ts')],
      outdir: dir, target: 'node', format: 'cjs',
    });
    expect(build.success).toBe(true);
    // Electron uses Node's CommonJS cache, not Bun's module cache.
    fs.writeFileSync(path.join(dir, 'check.cjs'), `
      const assert = require('node:assert/strict');
      const fs = require('node:fs');
      const { watchOwnerConfig } = require('./config.js');
      const file = __dirname + '/settings.cjs';
      const values = [], errors = [];
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const until = async condition => {
        const deadline = Date.now() + 5000;
        while (!condition() && Date.now() < deadline) await sleep(20);
        assert.ok(condition());
      };
      (async () => {
        fs.writeFileSync(file, "module.exports = { homepage: 'first' }");
        const stop = watchOwnerConfig(file, c => values.push(c.homepage), e => errors.push(e));
        try {
          assert.deepEqual(values, ['first']);
          fs.writeFileSync(file, 'module.exports = {');
          await until(() => errors.length > 0);
          assert.deepEqual(values, ['first']);
          fs.writeFileSync(file + '.new', "module.exports = { homepage: 'second' }");
          fs.renameSync(file + '.new', file);
          await until(() => values.at(-1) === 'second');
          stop();
          fs.writeFileSync(file, "module.exports = { homepage: 'third' }");
          await sleep(200);
          assert.equal(values.at(-1), 'second');
        } finally { stop(); }
      })().catch(e => { console.error(e); process.exitCode = 1; });
    `);
    const result = Bun.spawnSync(['node', path.join(dir, 'check.cjs')], { timeout: 15000 });
    expect(result.stderr.toString()).toBe('');
    expect(result.exitCode).toBe(0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

test('Ctrl+D closes only its own pane, not the shared owner', () => {
  const config = require('../../config.js');
  const quit = config.keybindings.linux['<C-d>'];
  let closed = 0;
  let sigint = 0;
  const onSigint = () => sigint++;
  process.on('SIGINT', onSigint);
  try {
    expect(quit({ view: { terminal: { actions: { close: () => closed++ } } } })).toBe(true);
    expect([closed, sigint]).toEqual([1, 0]);
  } finally {
    process.off('SIGINT', onSigint);
  }
});
