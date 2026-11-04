import type { Queryable } from '../db/pool.ts';

/**
 * Idempotent Consumer: claims a message id inside the caller's transaction. Returns false when it was
 * already processed; since the claim commits (or rolls back) together with the effect, a redelivered
 * message is never applied twice and a failed one is retried.
 */
export async function claimMessage(q: Queryable, messageId: string): Promise<boolean> {
  const res = await q.query(
    'INSERT INTO processed_messages (message_id) VALUES ($1) ON CONFLICT DO NOTHING',
    [messageId],
  );
  return res.rowCount === 1;
}
