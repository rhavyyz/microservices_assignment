import type { Queryable } from '../db/pool.ts';
import type { Envelope } from '../messaging/envelope.ts';

export type OutboxMessage = { topic: string; key: string; envelope: Envelope };
export type PendingMessage = OutboxMessage & { seq: string };

/** Transactional Outbox: stored in the same transaction as the business change it describes. */
export async function addToOutbox(q: Queryable, m: OutboxMessage): Promise<void> {
  await q.query(
    'INSERT INTO outbox (message_id, topic, message_key, payload) VALUES ($1, $2, $3, $4)',
    [m.envelope.message_id, m.topic, m.key, JSON.stringify(m.envelope)],
  );
}

/** Oldest unpublished messages, in insertion order. */
export async function pendingMessages(q: Queryable, limit: number): Promise<PendingMessage[]> {
  const res = await q.query(
    `SELECT seq, topic, message_key, payload FROM outbox
      WHERE published_at IS NULL ORDER BY seq LIMIT $1`,
    [limit],
  );
  return (res.rows as { seq: string; topic: string; message_key: string; payload: Envelope }[]).map((r) => ({
    seq: r.seq,
    topic: r.topic,
    key: r.message_key,
    envelope: r.payload,
  }));
}

export async function markPublished(q: Queryable, seqs: string[]): Promise<void> {
  await q.query('UPDATE outbox SET published_at = now() WHERE seq = ANY($1::bigint[])', [seqs]);
}

/** Deletes published messages older than the retention; returns how many were removed. */
export async function purgePublished(q: Queryable, retentionHours: number): Promise<number> {
  const res = await q.query(
    `DELETE FROM outbox WHERE published_at < now() - make_interval(hours => $1)`,
    [retentionHours],
  );
  return res.rowCount ?? 0;
}

/**
 * Only one relay publishes at a time (replicas included), which keeps the messages in `seq` order.
 * Transaction-scoped: released automatically at COMMIT/ROLLBACK.
 */
export async function tryRelayLock(q: Queryable): Promise<boolean> {
  const res = await q.query('SELECT pg_try_advisory_xact_lock(727003) AS locked');
  return (res.rows[0] as { locked: boolean }).locked;
}
