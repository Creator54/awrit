import { options } from '../args';
import { runAndroidCli } from './androidCli';
import { spawnSync } from 'node:child_process';
import { pickArgs } from '../picker';
import { showHelp } from '../help';

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') process.exit(0);
  throw error;
});

async function main(): Promise<void> {
  if (options.help) {
    showHelp();
    return;
  }
  if (options.pick) {
    const args = await pickArgs();
    if (!args) return;
    const launcher = process.env.AWRIT_LAUNCHER;
    if (!launcher) throw new Error('Awrit launcher path is missing');
    const result = spawnSync(launcher, args, { stdio: 'inherit' });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    return;
  }

  // Standalone entry for packaged installs (no Bun, no Electron).
  const code = await runAndroidCli(options);
  if (code === null)
    console.error('`view` needs the Electron viewer; launch it through the awrit wrapper.');
  process.exit(code ?? 1);
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
