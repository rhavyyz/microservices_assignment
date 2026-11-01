-- Apenas Inscrições escreve nestas tabelas. Não há FK para bancos de outros serviços.
CREATE TABLE activity_inventory (
    activity_id uuid PRIMARY KEY,
    event_id uuid NOT NULL,
    capacity integer NOT NULL CHECK (capacity >= 0),
    reserved integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
    confirmed integer NOT NULL DEFAULT 0 CHECK (confirmed >= 0),
    next_position bigint NOT NULL DEFAULT 0,
    lifecycle text NOT NULL DEFAULT 'OPEN' CHECK (lifecycle IN ('OPEN','ENDED','CANCELLED')),
    CHECK (reserved + confirmed <= capacity)
);

-- Proteção adicional: nem um UPDATE acidental pode alterar o limite copiado de Eventos.
CREATE FUNCTION immutable_capacity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.capacity <> OLD.capacity OR NEW.event_id <> OLD.event_id THEN
        RAISE EXCEPTION 'activity capacity and event are immutable';
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER inventory_immutable BEFORE UPDATE ON activity_inventory
FOR EACH ROW EXECUTE FUNCTION immutable_capacity();

CREATE TABLE registrations (
    id uuid PRIMARY KEY,
    activity_id uuid NOT NULL REFERENCES activity_inventory,
    user_id uuid NOT NULL,
    status text NOT NULL CHECK (status IN
      ('WAITLISTED','OFFERED','PENDING_PAYMENT','CONFIRMED','CANCELLED','EXPIRED','REJECTED')),
    amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
    currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    expires_at timestamptz,
    version integer NOT NULL DEFAULT 1,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    CHECK ((status IN ('OFFERED','PENDING_PAYMENT')) = (expires_at IS NOT NULL))
);
CREATE UNIQUE INDEX registration_active_unique ON registrations(activity_id,user_id)
WHERE status IN ('WAITLISTED','OFFERED','PENDING_PAYMENT','CONFIRMED');
CREATE INDEX registrations_owner ON registrations(user_id, created_at DESC);
CREATE INDEX registrations_activity ON registrations(activity_id, created_at);
CREATE INDEX registrations_expiry ON registrations(expires_at)
WHERE status IN ('OFFERED','PENDING_PAYMENT');

CREATE TABLE waitlist_entries (
    registration_id uuid PRIMARY KEY REFERENCES registrations,
    activity_id uuid NOT NULL REFERENCES activity_inventory,
    position bigint NOT NULL,
    UNIQUE(activity_id,position)
);
CREATE TABLE payment_attempts (
    id uuid PRIMARY KEY,
    registration_id uuid NOT NULL UNIQUE REFERENCES registrations,
    status text NOT NULL CHECK (status IN
      ('REQUESTED','APPROVED','DECLINED','EXPIRED','CANCEL_PENDING','CANCELLED','REFUND_PENDING','REFUNDED')),
    provider_version bigint NOT NULL DEFAULT 0,
    checked_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE attendance (
    registration_id uuid PRIMARY KEY REFERENCES registrations,
    checked_in_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    recorded_by uuid NOT NULL,
    eligible_emitted boolean NOT NULL DEFAULT false
);
CREATE TABLE outbox (
    sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    id uuid NOT NULL UNIQUE,
    topic text NOT NULL,
    message_key text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    published_at timestamptz
);
CREATE INDEX outbox_pending ON outbox(sequence) WHERE published_at IS NULL;
CREATE TABLE inbox (
    source text NOT NULL,
    event_id uuid NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(source,event_id)
);
CREATE TABLE idempotency_keys (
    user_id uuid NOT NULL,
    key text NOT NULL,
    fingerprint text NOT NULL,
    response jsonb NOT NULL,
    PRIMARY KEY(user_id,key)
);
