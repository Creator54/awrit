import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const INSTALL = 'Install Claude Code plugin (awrit-chat)';
const SKIP = 'Skip';

export type Exec = (file: string, args: string[]) => Promise<void>;

export interface PluginSetupOptions {
  root: string;
  dryRun: boolean;
  yes: boolean;
  interactive: boolean;
  select: (prompt: string, choices: string[]) => string | null;
  exec?: Exec;
}

export interface PluginSetupReceipt {
  installed: boolean;
  uninstalled?: boolean;
  dryRun: boolean;
  commands: string[][];
}

export function pluginRoot(env: NodeJS.ProcessEnv): string {
  if (env.AWRIT_PLUGIN_ROOT) return env.AWRIT_PLUGIN_ROOT;
  if (env.AWRIT_CHAT_PLUGIN_DIR) return path.resolve(env.AWRIT_CHAT_PLUGIN_DIR, '../..');
  throw new Error('Plugin root is missing; run through the Awrit launcher');
}

const defaultExec: Exec = async (file, args) => {
  try {
    await execFileAsync(file, args);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('claude CLI not found on PATH; install Claude Code first');
    }
    throw error;
  }
};

export async function setupPlugins(options: PluginSetupOptions): Promise<PluginSetupReceipt> {
  const { root, dryRun, yes, interactive, select, exec = defaultExec } = options;
  if (!yes && !interactive) {
    throw new Error('Interactive setup needs a TTY; pass --yes to run non-interactively');
  }
  const commands = [
    ['plugin', 'marketplace', 'add', root],
    ['plugin', 'install', 'awrit-chat@awrit'],
  ];
  if (!yes && select('Plugins', [INSTALL, SKIP]) !== INSTALL) {
    return { installed: false, dryRun, commands: [] };
  }
  if (!dryRun) for (const args of commands) await exec('claude', args);
  return { installed: !dryRun, dryRun, commands: commands.map((c) => ['claude', ...c]) };
}

export async function uninstallPlugins(
  options: Omit<PluginSetupOptions, 'select'>,
): Promise<PluginSetupReceipt> {
  const { dryRun, exec = defaultExec } = options;
  const commands = [
    ['plugin', 'uninstall', 'awrit-chat@awrit'],
    ['plugin', 'marketplace', 'remove', 'awrit'],
  ];
  if (!dryRun) {
    for (const args of commands) {
      try {
        await exec('claude', args);
      } catch {
        // Ignored if already uninstalled or marketplace not present
      }
    }
  }
  return {
    installed: false,
    uninstalled: !dryRun,
    dryRun,
    commands: commands.map((c) => ['claude', ...c]),
  };
}
