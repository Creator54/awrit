type PaintTarget = Pick<
  import('electron').WebContents,
  'once' | 'removeListener' | 'isDestroyed' | 'invalidate'
>;

/**
 * Resolve only after the target actually paints. The timeout is an error
 * boundary, never a fake success: a covered or destroyed page stays covered.
 */
export function waitForContentPaint(target: PaintTarget, timeoutMs = 2000): Promise<void> {
  if (target.isDestroyed()) return Promise.reject(new Error('Page closed before it painted'));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      target.removeListener('paint', painted);
      target.removeListener('destroyed', destroyed);
      clearTimeout(timer);
    };
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const painted = () => finish();
    const destroyed = () => finish(new Error('Page closed before it painted'));
    // Start the timer before any listener can fire so cleanup always clears a timer.
    const timer = setTimeout(() => finish(new Error('Page did not paint in time')), timeoutMs);
    target.once('paint', painted);
    target.once('destroyed', destroyed);
    target.invalidate();
  });
}
