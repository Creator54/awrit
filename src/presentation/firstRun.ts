import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const NOW = 'Set up now';
const LATER = 'Not now';
const NEVER = "Don't ask again";

/** Offers `awrit setup` once; `dir` is the app data directory. Returns true if setup ran. */
export async function offerSetupOnce(o: {
  dir: string;
  interactive: boolean;
  select: (prompt: string, choices: string[]) => (string | null) | Promise<string | null>;
  runSetup: () => Promise<void>;
}): Promise<boolean> {
  const state = path.join(o.dir, 'setup-offered');
  if (!o.interactive || existsSync(state)) return false;
  const choice = await o.select('Set up awrit for your coding agents?', [NOW, LATER, NEVER]);
  if (choice !== NOW && choice !== NEVER) return false;
  if (choice === NOW) await o.runSetup();
  mkdirSync(o.dir, { recursive: true });
  writeFileSync(state, '');
  return choice === NOW;
}
