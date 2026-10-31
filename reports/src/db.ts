import pg from 'pg';
import { config } from './config.ts';

export function createPool(): pg.Pool {
  return new pg.Pool({ connectionString: config.databaseUrl, max: 10, connectionTimeoutMillis: 3000 });
}

const MIGRATION = `
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id   text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS events (
  event_id      text PRIMARY KEY,
  organizer_id  text,
  name          text,
  status        text NOT NULL DEFAULT 'DRAFT',
  starts_at     timestamptz,
  ends_at       timestamptz,
  last_event_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS events_organizer_idx ON events (organizer_id);

CREATE TABLE IF NOT EXISTS activities (
  activity_id   text PRIMARY KEY,
  event_id      text NOT NULL,
  name          text,
  capacity      integer,
  paid          boolean NOT NULL DEFAULT false,
  last_event_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS activities_event_idx ON activities (event_id);

CREATE TABLE IF NOT EXISTS registrations (
  registration_id text PRIMARY KEY,
  event_id        text NOT NULL,
  activity_id     text NOT NULL,
  user_id         text,
  status          text NOT NULL,
  last_event_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS registrations_event_idx ON registrations (event_id);
CREATE INDEX IF NOT EXISTS registrations_activity_idx ON registrations (activity_id);

CREATE TABLE IF NOT EXISTS payments (
  payment_id      text PRIMARY KEY,
  registration_id text,
  event_id        text NOT NULL,
  activity_id     text,
  amount          numeric(12,2),
  currency        text,
  status          text NOT NULL,
  last_event_at   timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_event_idx ON payments (event_id);
CREATE INDEX IF NOT EXISTS payments_activity_idx ON payments (activity_id);

CREATE TABLE IF NOT EXISTS checkins (
  registration_id text PRIMARY KEY,
  event_id        text NOT NULL,
  activity_id     text NOT NULL,
  user_id         text,
  checked_at      timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS checkins_event_idx ON checkins (event_id);
CREATE INDEX IF NOT EXISTS checkins_activity_idx ON checkins (activity_id);
`;

/** Idempotent; the advisory lock makes replicas starting together safe. */
export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(727001)');
    await client.query(MIGRATION);
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
}
