/** Command misuse: bad arguments or an unusable target. Runtime failures stay plain Errors. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Prints one CLI failure and returns its exit code: 2 for misuse, 1 for a runtime failure. */
export function reportCliError(error: unknown, json: boolean): number {
  const message = error instanceof Error ? error.message : String(error);
  if (json) process.stdout.write(JSON.stringify({ error: message }) + '\n');
  else process.stderr.write(`awrit: ${message}\n`);
  return error instanceof UsageError ? 2 : 1;
}
