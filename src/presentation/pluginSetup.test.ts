import { describe, expect, test } from 'bun:test';
import { pluginRoot, setupPlugins, uninstallPlugins } from './pluginSetup';

const base = { root: '/r', dryRun: false, yes: true, interactive: true, select: () => null };
const record = () => {
  const calls: string[][] = [];
  return { calls, exec: async (f: string, a: string[]) => void calls.push([f, ...a]) };
};

describe('setupPlugins', () => {
  test('dry-run prints commands without running', async () => {
    const { calls, exec } = record();
    const r = await setupPlugins({ ...base, dryRun: true, exec });
    expect(calls).toEqual([]);
    expect(r.commands).toEqual([
      ['claude', 'plugin', 'marketplace', 'add', '/r'],
      ['claude', 'plugin', 'install', 'awrit-chat@awrit'],
    ]);
  });
  test('--yes runs both commands in order', async () => {
    const { calls, exec } = record();
    await setupPlugins({ ...base, exec });
    expect(calls).toEqual([
      ['claude', 'plugin', 'marketplace', 'add', '/r'],
      ['claude', 'plugin', 'install', 'awrit-chat@awrit'],
    ]);
  });
  test('skip runs nothing', async () => {
    const { calls, exec } = record();
    const r = await setupPlugins({ ...base, yes: false, select: () => 'Skip', exec });
    expect(calls).toEqual([]);
    expect(r.installed).toBe(false);
  });
  test('confirm installs', async () => {
    const { calls, exec } = record();
    await setupPlugins({ ...base, yes: false, select: (_p, c) => c[0], exec });
    expect(calls).toHaveLength(2);
  });
  test('missing claude errors', async () => {
    const exec = async () => {
      throw new Error('claude CLI not found on PATH; install Claude Code first');
    };
    await expect(setupPlugins({ ...base, exec })).rejects.toThrow('claude CLI not found');
  });
  test('non-TTY refused without --yes', async () => {
    await expect(setupPlugins({ ...base, yes: false, interactive: false })).rejects.toThrow('TTY');
  });
  test('root resolution', () => {
    expect(pluginRoot({ AWRIT_PLUGIN_ROOT: '/a' })).toBe('/a');
    expect(pluginRoot({ AWRIT_CHAT_PLUGIN_DIR: '/x/plugins/awrit-chat' })).toBe('/x');
  });
  test('uninstallPlugins runs plugin uninstall and marketplace remove', async () => {
    const { calls, exec } = record();
    const r = await uninstallPlugins({ ...base, exec });
    expect(calls).toEqual([
      ['claude', 'plugin', 'uninstall', 'awrit-chat@awrit'],
      ['claude', 'plugin', 'marketplace', 'remove', 'awrit'],
    ]);
    expect(r.uninstalled).toBe(true);
    expect(r.dryRun).toBe(false);
  });
  test('uninstallPlugins in dryRun executes no commands', async () => {
    const { calls, exec } = record();
    const r = await uninstallPlugins({ ...base, dryRun: true, exec });
    expect(calls).toEqual([]);
    expect(r.commands).toEqual([
      ['claude', 'plugin', 'uninstall', 'awrit-chat@awrit'],
      ['claude', 'plugin', 'marketplace', 'remove', 'awrit'],
    ]);
  });
});
