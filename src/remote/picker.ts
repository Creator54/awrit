import { spawn } from 'node:child_process';
import path from 'node:path';
import type { RemoteClientDeps } from './client';
import { remoteOwnerEntry } from './bridge';
import { type ChosenUpload, openChosenUpload } from './uploadSource';

export function uploadPickerCommand(host: string, env: NodeJS.ProcessEnv, cliPath: string) {
  // Mirrors ALIAS_PATTERN in sshCommand.ts; ssh aliases may contain @ (user@pool jump hosts).
  if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,252}$/.test(host)) throw new Error('Invalid upload host');
  if (!env.AWRIT_ELECTRON) throw new Error('Local Electron runtime unavailable for file selection');
  return {
    command: env.AWRIT_ELECTRON,
    args: [
      path.resolve(path.dirname(remoteOwnerEntry(env, cliPath)), '../remote/pickerMain.js'),
      host,
    ],
  };
}
export function parsePickedFile(stdout: string): string | undefined {
  if (!stdout.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error('Invalid local picker result');
  }
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== 1 ||
    !('file' in value) ||
    typeof value.file !== 'string' ||
    !path.isAbsolute(value.file) ||
    value.file.includes('\0')
  )
    throw new Error('Invalid local picker result');
  return value.file;
}

/** Only the types the artifact layer accepts; anything else is refused before the offer. */
const UPLOAD_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

function uploadMimeFor(file: string): string {
  const mime = UPLOAD_MIME[path.extname(file).toLowerCase()];
  if (!mime) throw new Error('Unsupported file type');
  return mime;
}

/** Time an ignored SIGTERM gets before SIGKILL on abort. */
const KILL_GRACE_MS = 2_000;

/**
 * The local file chooser for a remote page, or undefined when no local Electron runtime
 * exists (the client then cancels and says selection is unsupported). The remote only ever
 * supplies the alias; the path comes from the user's dialog.
 */
export function createUploadChooser(
  env: NodeJS.ProcessEnv,
  spawnFn: typeof spawn = spawn,
  cliPath: string = process.argv[1] ?? '',
): RemoteClientDeps['chooseUpload'] | undefined {
  if (!env.AWRIT_ELECTRON) return undefined;
  return async (host, signal) => {
    if (signal.aborted) return undefined;
    const { command, args } = uploadPickerCommand(host, env, cliPath);
    const child = spawnFn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stderr?.pipe(process.stderr);
    let stdout = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      stdout += chunk;
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', () => resolve());
      });
      if (signal.aborted) return undefined;
      const file = parsePickedFile(stdout);
      if (!file) return undefined;
      const mime = uploadMimeFor(file);
      const source: ChosenUpload = await openChosenUpload(file);
      return { source, mime };
    } finally {
      signal.removeEventListener('abort', abort);
      if (killTimer) clearTimeout(killTimer);
    }
  };
}
