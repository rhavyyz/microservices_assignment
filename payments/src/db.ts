import pg from 'pg';
import { config } from './config.ts';

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 3000 });
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS payments (
  payment_id      uuid PRIMARY KEY,
  registration_id text NOT NULL UNIQUE,
  user_id         text NOT NULL,
  event_id        text NOT NULL,
  activity_id     text NOT NULL,
  amount          numeric(12,2) NOT NULL CHECK (amount > 0),
  currency        text NOT NULL,
  status          text NOT NULL CHECK (status IN ('PENDING','CONFIRMED','REFUSED','EXPIRED','CANCELLED')),
  expires_at      timestamptz NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payments_user_idx ON payments (user_id);
CREATE INDEX IF NOT EXISTS payments_pending_expiry_idx ON payments (expires_at) WHERE status = 'PENDING';

-- Every state change, with who/why: the payment's history (also feeds the audit trail).
CREATE TABLE IF NOT EXISTS payment_transitions (
  id             bigserial PRIMARY KEY,
  payment_id     uuid NOT NULL REFERENCES payments (payment_id),
  from_status    text,
  to_status      text NOT NULL,
  reason         text,
  correlation_id text,
  at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS payment_transitions_payment_idx ON payment_transitions (payment_id);

-- Transactional outbox: events are written in the same transaction as the state change and sent to Kafka afterwards.
CREATE TABLE IF NOT EXISTS outbox (
  id           bigserial PRIMARY KEY,
  topic        text NOT NULL,
  key          text NOT NULL,
  value        text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (id) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS processed_messages (
  message_id   text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);
`;

/** Idempotent; the advisory lock makes replicas starting together safe. */
export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727002)');
    await client.query(MIGRATION);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727002)').catch(() => {});
    client.release();
  }
}
