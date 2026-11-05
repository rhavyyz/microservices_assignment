// Input validation: the REST body of POST /payments and the Subscription events Payments consumes.

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Body of POST /payments: only the registration id; everything else comes from Subscription. Unknown properties are ignored. */
export function validateCreate(body: unknown): Validation<{ registrationId: string }> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const id = (body as Record<string, unknown>).registration_id;
  if (typeof id !== 'string' || !UUID.test(id.trim())) return { ok: false, error: 'registration_id must be a UUID' };
  return { ok: true, value: { registrationId: id.trim().toLowerCase() } };
}

/** What Payments creates a payment from (filled from Subscription's answer, never from the client). */
export type CreateInput = {
  registrationId: string;
  userId: string;
  eventId: string | null;
  amountMinor: number;
  currency: string;
  expiresAt: Date;
};

const CLOSING_TYPES: Record<string, string> = {
  RegistrationCancelled: 'registration_cancelled',
  RegistrationExpired: 'registration_expired',
};

export type SubscriptionMessage = {
  eventId: string;
  type: string;
  registrationId: string;
  requestId: string | null;
  /** Set only for the types that close a registration (cancel / expire); null means "ignore this message". */
  closeReason: string | null;
};

/** Parses a message of `subscription.events` (flat envelope). Unknown types and extra fields are fine. */
export function parseSubscriptionMessage(raw: string): Validation<SubscriptionMessage> {
  let o: unknown;
  try {
    o = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'not valid JSON' };
  }
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return { ok: false, error: 'not a JSON object' };
  const m = o as Record<string, unknown>;
  const need = (k: string): string | null => {
    const v = m[k];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
  };
  const eventId = need('event_id');
  const type = need('type');
  const registrationId = need('registration_id');
  if (!eventId) return { ok: false, error: 'event_id is required' };
  if (!type) return { ok: false, error: 'type is required' };
  if (!registrationId) return { ok: false, error: 'registration_id is required' };
  const v = m.schema_version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) return { ok: false, error: 'schema_version must be an integer' };
  if (v > 1) return { ok: false, error: `unsupported schema_version ${v}` };
  return {
    ok: true,
    value: { eventId, type, registrationId, requestId: need('request_id'), closeReason: CLOSING_TYPES[type] ?? null },
  };
}
