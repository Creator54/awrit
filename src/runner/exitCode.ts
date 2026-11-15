// Launcher exit status for a finished Electron child: its own code, 1 if a signal killed it.
export function childExitCode(exitCode: number | null, signalCode: string | number | null): number {
  if (exitCode !== null) return exitCode;
  return signalCode !== null ? 1 : 0;
}
