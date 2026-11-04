import type pg from 'pg';
import type { Log } from '../audit.ts';
import { withTransaction } from '../db/pool.ts';
import { markPublished, pendingMessages, purgePublished, tryRelayLock, type OutboxMessage } from '../repositories/outbox.ts';
import { sleep } from '../retry.ts';

/** Sends a batch to the broker, in order; throws if any message was not acknowledged. */
export type Publisher = (messages: OutboxMessage[]) => Promise<void>;

export type RelayOptions = {
  pool: pg.Pool;
  publish: Publisher;
  batchSize: number;
  intervalMs: number;
  retentionHours: number;
  log: Log;
};

const PURGE_EVERY_MS = 3600_000;
const ERROR_LOG_EVERY_MS = 30_000;

/**
 * Transactional Outbox relay: reads committed messages in `seq` order, publishes them and marks them
 * published. Delivery is at-least-once: if the mark is lost after a successful send, the message is
 * sent again with the same message_id, which every consumer deduplicates. While Kafka is down the
 * messages simply wait in the table; nothing the HTTP API does is blocked by the broker (RQ03).
 */
export function createOutboxRelay(opts: RelayOptions) {
  /** Publishes one batch; returns how many messages went out (0 when idle or another relay holds the lock). */
  async function publishBatch(): Promise<number> {
    return withTransaction(opts.pool, async (tx) => {
      if (!(await tryRelayLock(tx))) return 0;
      const batch = await pendingMessages(tx, opts.batchSize);
      if (batch.length === 0) return 0;
      await opts.publish(batch); // a failure rolls back: nothing is marked, the batch is retried
      await markPublished(tx, batch.map((m) => m.seq));
      return batch.length;
    });
  }

  let running = false;
  let loop: Promise<void> | null = null;

  async function run(): Promise<void> {
    let lastPurge = 0;
    let lastErrorLog = 0;
    while (running) {
      try {
        const sent = await publishBatch();
        if (Date.now() - lastPurge > PURGE_EVERY_MS) {
          lastPurge = Date.now();
          const purged = await purgePublished(opts.pool, opts.retentionHours);
          if (purged > 0) opts.log.info({ purged }, 'outbox: published messages purged');
        }
        if (sent === opts.batchSize) continue; // more may be waiting: no pause
      } catch (e) {
        if (Date.now() - lastErrorLog > ERROR_LOG_EVERY_MS) { // a broker outage is logged, not flooded
          lastErrorLog = Date.now();
          opts.log.warn({ err: (e as Error).message }, 'outbox: publish failed; will retry');
        }
      }
      await sleep(opts.intervalMs);
    }
  }

  return {
    publishBatch,
    start(): void {
      if (running) return;
      running = true;
      loop = run();
    },
    async stop(): Promise<void> {
      running = false;
      await loop;
    },
  };
}
