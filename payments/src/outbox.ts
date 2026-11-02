import { type Producer } from 'kafkajs';
import type { Pool, PoolClient } from 'pg';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
export type OutboxMessage = { topic: string; key: string; value: string };

/** Called inside the transaction that changes the payment: the event exists if and only if the change does. */
export async function enqueue(client: PoolClient, messages: OutboxMessage[]): Promise<void> {
  for (const m of messages) {
    await client.query('INSERT INTO outbox (topic, key, value) VALUES ($1, $2, $3)', [m.topic, m.key, m.value]);
  }
}

/**
 * Sends a batch of pending rows to Kafka and marks them published, in one transaction. If Kafka fails the
 * rows stay pending and are retried (at-least-once: consumers are idempotent by message_id).
 * No SKIP LOCKED on purpose: a second replica waits instead of overtaking, which keeps the order per key.
 */
export async function publishPending(pool: Pool, producer: Producer, batch = 100): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await client.query<{ id: string; topic: string; key: string; value: string }>(
      'SELECT id, topic, key, value FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1 FOR UPDATE',
      [batch],
    );
    if (r.rows.length === 0) {
      await client.query('COMMIT');
      return 0;
    }
    const byTopic = new Map<string, { key: string; value: string }[]>();
    for (const row of r.rows) {
      const list = byTopic.get(row.topic) ?? [];
      list.push({ key: row.key, value: row.value });
      byTopic.set(row.topic, list);
    }
    await producer.sendBatch({
      acks: -1,
      topicMessages: [...byTopic].map(([topic, messages]) => ({ topic, messages })),
    });
    await client.query('UPDATE outbox SET published_at = now() WHERE id = ANY($1::bigint[])', [r.rows.map((x) => x.id)]);
    await client.query('COMMIT');
    return r.rows.length;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export function startOutboxWorker(
  pool: Pool,
  getProducer: () => Producer | undefined,
  log: Log,
  intervalMs: number,
): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let lastWarn = 0;

  const tick = async () => {
    try {
      const producer = getProducer();
      if (producer) {
        let n: number;
        do {
          n = await publishPending(pool, producer);
          if (n > 0) log.info({ published: n }, 'outbox published');
        } while (n === 100 && !stopped);
      }
    } catch (e) {
      if (Date.now() - lastWarn > 30000) {
        lastWarn = Date.now();
        log.warn({ err: (e as Error).message }, 'outbox publish failed; will retry');
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  };

  timer = setTimeout(tick, intervalMs);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
