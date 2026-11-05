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
  event_id        text,
  activity_id     text,
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  currency        text NOT NULL,
  status          text NOT NULL CHECK (status IN ('PENDING','APPROVED','DECLINED','EXPIRED','CANCELLED','REFUNDED')),
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
  trace_id       text,
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

-- v2: money as integer minor units (2500 = 25.00). Databases created before this have numeric(12,2) "amount";
-- convert them in place (no-op on fresh databases, which already have amount_minor).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'payments' AND column_name = 'amount') THEN
    ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_minor bigint;
    UPDATE payments SET amount_minor = round(amount * 100)::bigint WHERE amount_minor IS NULL;
    ALTER TABLE payments ALTER COLUMN amount_minor SET NOT NULL;
    ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_amount_minor_check;
    ALTER TABLE payments ADD CONSTRAINT payments_amount_minor_check CHECK (amount_minor > 0);
    ALTER TABLE payments DROP COLUMN amount;
  END IF;
END $$;

-- v3: statuses CONFIRMED/REFUSED became APPROVED/DECLINED. Replace the old CHECK, rewrite rows and history, add the new CHECK.
-- No-op on fresh databases and on re-runs (nothing matches, and payments_status_check already exists).
DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
            WHERE conrelid = 'payments'::regclass AND contype = 'c'
              AND pg_get_constraintdef(oid) LIKE '%status%'
              AND (pg_get_constraintdef(oid) LIKE '%CONFIRMED%' OR pg_get_constraintdef(oid) LIKE '%REFUSED%')
  LOOP
    EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', c.conname);
  END LOOP;
  UPDATE payments SET status = 'APPROVED' WHERE status = 'CONFIRMED';
  UPDATE payments SET status = 'DECLINED' WHERE status = 'REFUSED';
  UPDATE payment_transitions SET from_status = 'APPROVED' WHERE from_status = 'CONFIRMED';
  UPDATE payment_transitions SET from_status = 'DECLINED' WHERE from_status = 'REFUSED';
  UPDATE payment_transitions SET to_status = 'APPROVED' WHERE to_status = 'CONFIRMED';
  UPDATE payment_transitions SET to_status = 'DECLINED' WHERE to_status = 'REFUSED';
  UPDATE payment_transitions SET reason = 'simulated_approval' WHERE reason = 'simulated_confirmation';
  UPDATE payment_transitions SET reason = 'simulated_decline' WHERE reason = 'simulated_refusal';
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'payments'::regclass AND conname = 'payments_status_check') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_status_check
      CHECK (status IN ('PENDING','APPROVED','DECLINED','EXPIRED','CANCELLED'));
  END IF;
END $$;

-- v5: payment_transitions.correlation_id became request_id (only if the old column is there and the new one is not).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'payment_transitions' AND column_name = 'correlation_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'payment_transitions' AND column_name = 'request_id') THEN
    ALTER TABLE payment_transitions RENAME COLUMN correlation_id TO request_id;
  END IF;
END $$;

-- (There is no v6: that number was retired, like v4. It dropped payments.activity_id, which Payments keeps after all; v10 restores it.)

-- v7: REFUNDED status, and payments.event_id (the Events-service event) becomes nullable (Subscription may not know it for old rows).
-- Replaces the status CHECK only when the current one does not mention REFUNDED yet; DROP NOT NULL is a no-op if already nullable.
DO $$
DECLARE c record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conrelid = 'payments'::regclass AND contype = 'c'
                    AND pg_get_constraintdef(oid) LIKE '%status%' AND pg_get_constraintdef(oid) LIKE '%REFUNDED%') THEN
    FOR c IN SELECT conname FROM pg_constraint
              WHERE conrelid = 'payments'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%status%'
    LOOP
      EXECUTE format('ALTER TABLE payments DROP CONSTRAINT %I', c.conname);
    END LOOP;
    ALTER TABLE payments ADD CONSTRAINT payments_status_check
      CHECK (status IN ('PENDING','APPROVED','DECLINED','EXPIRED','CANCELLED','REFUNDED'));
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'payments' AND column_name = 'event_id' AND is_nullable = 'NO') THEN
    ALTER TABLE payments ALTER COLUMN event_id DROP NOT NULL;
  END IF;
END $$;

-- v8: processed_messages keeps message_id (the id of the Kafka message). A short-lived revision renamed it to event_id
-- (the old v4 block, since removed); undo that on any database that already ran it. Renames only when event_id exists
-- and message_id does not, so it is a no-op on fresh databases and re-runs. (There is no v4: that number was retired.)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'processed_messages' AND column_name = 'event_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'processed_messages' AND column_name = 'message_id') THEN
    ALTER TABLE processed_messages RENAME COLUMN event_id TO message_id;
  END IF;
END $$;

-- v9: request_id became trace_id (the same value, renamed). payment_transitions.request_id is renamed
-- only if the old column is there and the new one is not.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'payment_transitions' AND column_name = 'request_id')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'payment_transitions' AND column_name = 'trace_id') THEN
    ALTER TABLE payment_transitions RENAME COLUMN request_id TO trace_id;
  END IF;
END $$;

-- v10: payments.activity_id is back (it comes from Subscription's lookup). Adds the column if it is missing (databases that
-- ran the retired v6) and makes it nullable if it is NOT NULL (databases from main): payments created while the column
-- was gone cannot be backfilled. No-op on fresh databases and re-runs.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'payments' AND column_name = 'activity_id') THEN
    ALTER TABLE payments ADD COLUMN activity_id text;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = current_schema() AND table_name = 'payments' AND column_name = 'activity_id' AND is_nullable = 'NO') THEN
    ALTER TABLE payments ALTER COLUMN activity_id DROP NOT NULL;
  END IF;
END $$;
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
