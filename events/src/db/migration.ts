// Schema of events-db. Idempotent: it runs at every startup (see migrate in db/pool.ts).
// The database is the last line of defense for the invariants, so they are constraints, not just code:
// no overbooking (RN01), immutable capacity, valid periods and statuses.

export const MIGRATION = `
CREATE TABLE IF NOT EXISTS events (
  id           uuid PRIMARY KEY,
  organizer_id text        NOT NULL,
  organization text,
  title        text        NOT NULL CHECK (btrim(title) <> ''),
  description  text,
  location     text,
  banner_url   text,
  starts_at    timestamptz NOT NULL,
  ends_at      timestamptz NOT NULL,
  status       text        NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'CANCELLED')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT events_valid_period CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS events_organizer_idx ON events (organizer_id, starts_at);
CREATE INDEX IF NOT EXISTS events_published_idx ON events (starts_at) WHERE status = 'PUBLISHED';

CREATE TABLE IF NOT EXISTS activities (
  id               uuid        PRIMARY KEY,
  event_id         uuid        NOT NULL REFERENCES events (id),
  title            text        NOT NULL CHECK (btrim(title) <> ''),
  description      text,
  speaker          text,
  location         text,
  starts_at        timestamptz NOT NULL,
  ends_at          timestamptz NOT NULL,
  capacity         integer     NOT NULL CHECK (capacity > 0),
  reserved         integer     NOT NULL DEFAULT 0,
  available        integer     GENERATED ALWAYS AS (capacity - reserved) STORED,
  price_cents      integer     NOT NULL DEFAULT 0 CHECK (price_cents >= 0),
  paid             boolean     GENERATED ALWAYS AS (price_cents > 0) STORED,
  waitlist_enabled boolean     NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activities_valid_period CHECK (ends_at > starts_at),
  CONSTRAINT activities_no_overbooking CHECK (reserved BETWEEN 0 AND capacity)
);
CREATE INDEX IF NOT EXISTS activities_event_idx ON activities (event_id, starts_at);

CREATE OR REPLACE FUNCTION activities_capacity_is_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW.capacity <> OLD.capacity THEN
    RAISE EXCEPTION 'activity capacity is immutable' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE OR REPLACE TRIGGER activities_capacity_is_immutable
  BEFORE UPDATE OF capacity ON activities
  FOR EACH ROW EXECUTE FUNCTION activities_capacity_is_immutable();

-- One row per registration that ever held a seat: makes reserve/release idempotent per registration.
CREATE TABLE IF NOT EXISTS seat_reservations (
  registration_id text        PRIMARY KEY,
  activity_id     uuid        NOT NULL REFERENCES activities (id),
  event_id        uuid        NOT NULL,
  user_id         text,
  status          text        NOT NULL CHECK (status IN ('HELD', 'RELEASED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seat_reservations_held_idx ON seat_reservations (activity_id) WHERE status = 'HELD';

-- Idempotent Consumer: ids of the Kafka messages already applied, written in the same transaction as the effect.
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id   text        PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Transactional Outbox: messages written with the business change, published to Kafka by the relay.
CREATE TABLE IF NOT EXISTS outbox (
  seq          bigserial   PRIMARY KEY,
  message_id   uuid        NOT NULL UNIQUE,
  topic        text        NOT NULL,
  message_key  text        NOT NULL,
  payload      jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (seq) WHERE published_at IS NULL;

-- Activity lifecycle: set when the activity ends (manually after ends_at, or by the automatic end).
-- The reserved and available columns, seat_reservations and processed_messages are no longer used (Subscription counts the
-- seats) but are left in place: the migration is non-destructive.
ALTER TABLE activities ADD COLUMN IF NOT EXISTS ended_at timestamptz;
CREATE INDEX IF NOT EXISTS activities_open_end_idx ON activities (ends_at) WHERE ended_at IS NULL;
`;
