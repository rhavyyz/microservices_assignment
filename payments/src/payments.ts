import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { config } from './config.ts';
import type { CreateInput } from './contracts.ts';
import { buildNotification, buildPaymentEvent } from './events.ts';
import { enqueue, type OutboxMessage } from './outbox.ts';
import { decide, type Status } from './state.ts';

export type PaymentRow = {
  payment_id: string;
  registration_id: string;
  user_id: string;
  event_id: string | null;
  amount_minor: number;
  currency: string;
  status: Status;
  expires_at: Date;
  created_at: Date;
};

const COLS = 'payment_id, registration_id, user_id, event_id, amount_minor, currency, status, expires_at, created_at';

// bigint comes back from pg as a string.
type RawRow = Omit<PaymentRow, 'amount_minor'> & { amount_minor: string };

function map(r: RawRow): PaymentRow {
  return { ...r, amount_minor: Number(r.amount_minor) };
}

export async function getById(pool: Pool, id: string): Promise<PaymentRow | null> {
  const r = await pool.query<RawRow>(`SELECT ${COLS} FROM payments WHERE payment_id = $1`, [id]);
  return r.rows[0] ? map(r.rows[0]) : null;
}

export async function getByRegistration(pool: Pool, registrationId: string): Promise<PaymentRow | null> {
  const r = await pool.query<RawRow>(`SELECT ${COLS} FROM payments WHERE registration_id = $1`, [registrationId]);
  return r.rows[0] ? map(r.rows[0]) : null;
}

/** What goes to Kafka for a payment that just reached `p.status`: the event and, when needed, a user notice. */
function outboxFor(p: PaymentRow, reason: string | null, requestId: string | null): OutboxMessage[] {
  const now = new Date();
  const ev = buildPaymentEvent(p, reason, requestId, randomUUID(), now);
  const out: OutboxMessage[] = [{ topic: config.paymentEventsTopic, ...ev }];
  const note = buildNotification(p);
  if (note) out.push({ topic: config.notificationsTopic, ...note });
  return out;
}

export type Outcome = 'applied' | 'noop' | 'rejected';
export type Settled = { outcome: Outcome; payment: PaymentRow; detail?: string };

/**
 * Moves a locked payment toward `target` following the state machine. Must run inside a transaction
 * where `row` was read FOR UPDATE; the caller commits (also when the outcome is 'rejected': a late
 * approval turns the payment into EXPIRED, and that change must be kept).
 */
export async function applyTarget(
  client: PoolClient,
  row: PaymentRow,
  target: Status,
  reason: string,
  requestId: string | null,
  now: Date,
): Promise<Settled> {
  const d = decide(row.status, target, reason, row.expires_at, now);
  if (d.kind === 'noop') return { outcome: 'noop', payment: row };
  if (d.kind === 'reject') return { outcome: 'rejected', payment: row, detail: d.reason };

  const upd = await client.query<RawRow>(
    `UPDATE payments SET status = $2, updated_at = now() WHERE payment_id = $1 RETURNING ${COLS}`,
    [row.payment_id, d.to],
  );
  const payment = map(upd.rows[0]);
  await client.query(
    'INSERT INTO payment_transitions (payment_id, from_status, to_status, reason, request_id) VALUES ($1, $2, $3, $4, $5)',
    [row.payment_id, row.status, d.to, d.reason, requestId],
  );
  await enqueue(client, outboxFor(payment, d.reason, requestId));
  return d.granted
    ? { outcome: 'applied', payment }
    : { outcome: 'rejected', payment, detail: `payment ${d.to}: ${d.reason}` };
}

async function lock(client: PoolClient, by: 'payment_id' | 'registration_id', value: string): Promise<PaymentRow | null> {
  const r = await client.query<RawRow>(`SELECT ${COLS} FROM payments WHERE ${by} = $1 FOR UPDATE`, [value]);
  return r.rows[0] ? map(r.rows[0]) : null;
}

async function inTransaction<T>(pool: Pool, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/** Idempotent by registration_id: repeating the call returns the payment that already exists. */
export async function createPayment(
  pool: Pool,
  input: CreateInput,
  requestId: string | null,
): Promise<{ payment: PaymentRow; created: boolean }> {
  return inTransaction(pool, async (client) => {
    const ins = await client.query<RawRow>(
      `INSERT INTO payments (payment_id, registration_id, user_id, event_id, amount_minor, currency, status, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', $7)
       ON CONFLICT (registration_id) DO NOTHING
       RETURNING ${COLS}`,
      [randomUUID(), input.registrationId, input.userId, input.eventId, input.amountMinor, input.currency, input.expiresAt],
    );
    if (ins.rows[0]) {
      const payment = map(ins.rows[0]);
      await client.query(
        'INSERT INTO payment_transitions (payment_id, from_status, to_status, reason, request_id) VALUES ($1, NULL, $2, $3, $4)',
        [payment.payment_id, 'PENDING', 'created', requestId],
      );
      await enqueue(client, outboxFor(payment, null, requestId));
      return { payment, created: true };
    }
    const existing = await client.query<RawRow>(`SELECT ${COLS} FROM payments WHERE registration_id = $1`, [input.registrationId]);
    return { payment: map(existing.rows[0]), created: false };
  });
}

/** Used by the simulated provider endpoint. Returns null when the payment does not exist. */
export async function settleById(
  pool: Pool,
  id: string,
  target: Status,
  reason: string,
  requestId: string | null,
): Promise<Settled | null> {
  return inTransaction(pool, async (client) => {
    const row = await lock(client, 'payment_id', id);
    if (!row) return null;
    return applyTarget(client, row, target, reason, requestId, new Date());
  });
}

/**
 * Idempotent consumer step for Subscription's RegistrationCancelled / RegistrationExpired: the event id (dedupe in
 * processed_messages) and its effect are committed together. PENDING -> CANCELLED, APPROVED -> REFUNDED;
 * a payment in any other state, or no payment at all, is a no-op.
 */
export async function closeForRegistration(
  pool: Pool,
  eventId: string,
  registrationId: string,
  reason: string,
  requestId: string | null,
): Promise<'duplicate' | 'no_payment' | Outcome> {
  return inTransaction(pool, async (client) => {
    const seen = await client.query('INSERT INTO processed_messages (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
    if (seen.rowCount === 0) return 'duplicate';
    const row = await lock(client, 'registration_id', registrationId);
    if (!row) return 'no_payment';
    if (row.status !== 'PENDING' && row.status !== 'APPROVED') return 'noop';
    const target = row.status === 'APPROVED' ? 'REFUNDED' : 'CANCELLED';
    const res = await applyTarget(client, row, target, reason, requestId, new Date());
    return res.outcome;
  });
}

/** Expires pending payments whose deadline passed (RN02/RN03). Safe with several replicas (SKIP LOCKED). */
export async function expireDue(pool: Pool, limit = 50, now = new Date()): Promise<number> {
  return inTransaction(pool, async (client) => {
    const r = await client.query<RawRow>(
      `SELECT ${COLS} FROM payments WHERE status = 'PENDING' AND expires_at <= $1
        ORDER BY expires_at LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [now, limit],
    );
    for (const raw of r.rows) {
      await applyTarget(client, map(raw), 'EXPIRED', 'payment_deadline', randomUUID(), now);
    }
    return r.rows.length;
  });
}
