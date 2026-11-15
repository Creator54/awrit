// The user's own clicks, keys and scrolls take priority over agent actions.
// Agent tools call webContents directly, so anything seen by the input handler is the user's.
export const USER_IDLE_MS = 1_500;
export const USER_WAIT_MS = 3_000;

let lastUserInputAt = Number.NEGATIVE_INFINITY;

export function noteUserInput(now = Date.now()): void {
  lastUserInputAt = now;
}

export function resetUserInput(): void {
  lastUserInputAt = Number.NEGATIVE_INFINITY;
}

/** Resolves true once the user has been idle for USER_IDLE_MS, false if still active after USER_WAIT_MS. */
export async function waitForUserIdle(onWait?: () => void): Promise<boolean> {
  const giveUpAt = Date.now() + USER_WAIT_MS;
  for (;;) {
    const now = Date.now();
    const idleIn = lastUserInputAt + USER_IDLE_MS - now;
    if (idleIn <= 0) return true;
    onWait?.();
    onWait = undefined;
    if (now + idleIn > giveUpAt) return false;
    await new Promise((resolve) => setTimeout(resolve, idleIn));
  }
}
