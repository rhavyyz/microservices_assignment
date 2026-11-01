export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 1s doubling up to a cap: the retry policy shared with the discovery libs of the other languages. */
export function backoffDelay(attempt: number, baseMs = 1000, capMs = 30000): number {
  return Math.min(capMs, baseMs * 2 ** Math.min(attempt, 20));
}

/** Keeps calling fn until it resolves, waiting with backoff between failures (background startup tasks). */
export async function retryForever(
  name: string,
  fn: () => Promise<void>,
  onError: (name: string, error: Error, delayMs: number) => void,
  wait: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      const delay = backoffDelay(attempt);
      onError(name, e as Error, delay);
      await wait(delay);
    }
  }
}
