import type { Pool } from 'pg';
import { expireDue } from './payments.ts';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

export function startExpiryJob(pool: Pool, log: Log, intervalMs: number): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;

  const tick = async () => {
    try {
      let n: number;
      do {
        n = await expireDue(pool, 50);
        if (n > 0) log.info({ expired: n }, 'expired pending payments');
      } while (n === 50 && !stopped);
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'expiry job failed; will retry');
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
