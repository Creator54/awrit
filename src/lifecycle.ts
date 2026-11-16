/** Roll back partially acquired resources without hiding the original failure. */
export async function withConstructionCleanup<T>(
  construct: (onFailure: (cleanup: () => void) => void) => Promise<T>,
): Promise<T> {
  const cleanups: Array<() => void> = [];
  try {
    return await construct((cleanup) => cleanups.push(cleanup));
  } catch (error) {
    for (const cleanup of cleanups.reverse()) {
      try {
        cleanup();
      } catch (cleanupError) {
        console.error('Construction cleanup failed:', cleanupError);
      }
    }
    throw error;
  }
}
