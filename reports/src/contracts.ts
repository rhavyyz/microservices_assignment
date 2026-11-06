// Event contract consumed by the reports service (flat envelope, PascalCase types). See README.md ("Event contract").

export type Envelope = {
  message_id: string;
  type: string;
  schema_version: number;
  occurred_at: string;
  trace_id: string | null;
};

export type Change =
  | { kind: 'event'; eventId: string; organizerId: string | null; name: string | null; status: string | null; startsAt: string | null; endsAt: string | null }
  | { kind: 'activity'; activityId: string; eventId: string; name: string | null; capacity: number | null; paid: boolean | null }
  | { kind: 'registration'; registrationId: string; eventId: string; activityId: string; userId: string | null; status: string }
  // amount is the exact decimal in the major unit ("25.00"), converted from the producer's integer cents.
  | { kind: 'payment'; paymentId: string; registrationId: string | null; eventId: string; activityId: string | null; amount: string | null; currency: string | null; status: string }
  | { kind: 'checkin'; registrationId: string; eventId: string; activityId: string; userId: string | null }
  | { kind: 'ignored' };

export type Parsed = { envelope: Envelope; change: Change };
export type ParseResult = { ok: true; value: Parsed } | { ok: false; error: string };

// The type's fields sit at the root of the message, next to the envelope fields (no nested `data`).
type Data = Record<string, unknown>;

function reqStr(d: Data, k: string): string {
  const v = d[k];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${k} is required`);
  return v.trim();
}

function optStr(d: Data, k: string): string | null {
  const v = d[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new Error(`${k} must be a string`);
  const t = v.trim();
  return t === '' ? null : t;
}

function optNum(d: Data, k: string): number | null {
  const v = d[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${k} must be a number`);
  return v;
}

function optBool(d: Data, k: string): boolean | null {
  const v = d[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'boolean') throw new Error(`${k} must be a boolean`);
  return v;
}

function optDate(d: Data, k: string): string | null {
  const s = optStr(d, k);
  if (s === null) return null;
  if (Number.isNaN(Date.parse(s))) throw new Error(`${k} must be an ISO date`);
  return s;
}

/**
 * Integer cents (the producers' `amount_minor`) to the decimal major unit Reports stores, as an exact
 * string ("2500" -> "25.00"): integer division and remainder, never float arithmetic.
 */
function optMinorAsDecimal(d: Data, k: string): string | null {
  const v = d[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new Error(`${k} must be a non-negative integer (minor units)`);
  }
  const cents = v % 100;
  return `${(v - cents) / 100}.${String(cents).padStart(2, '0')}`;
}

// Subscription registration and check-in messages carry no event_id (only AttendanceEligible does), and
// Reports keys its rows by event. Until that is decided they are rejected, with this explicit reason.
function reqEventIdFromSubscription(d: Data): string {
  const v = d.event_id;
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error('event_id is required (Subscription registration messages do not carry it yet)');
  }
  return v.trim();
}

// A null status means "take it from status" (or keep the stored one).
const EVENT_STATUS: Record<string, string | null> = {
  EventCreated: null,
  EventUpdated: null,
  EventPublished: 'PUBLISHED',
  EventCancelled: 'CANCELLED',
};

const REGISTRATION_STATUS: Record<string, string> = {
  RegistrationPendingPayment: 'PENDING', // the seat is held until the payment settles
  RegistrationConfirmed: 'CONFIRMED',
  RegistrationWaitlisted: 'WAITLISTED',
  RegistrationCancelled: 'CANCELLED',
  RegistrationExpired: 'EXPIRED',
};

const PAYMENT_STATUS: Record<string, string> = {
  PaymentCreated: 'PENDING',
  PaymentApproved: 'CONFIRMED',
  PaymentDeclined: 'REFUSED',
  PaymentExpired: 'EXPIRED',
  PaymentCancelled: 'CANCELLED',
};

function toChange(type: string, d: Data): Change {
  if (Object.hasOwn(EVENT_STATUS, type)) {
    return {
      kind: 'event',
      eventId: reqStr(d, 'event_id'),
      organizerId: optStr(d, 'organizer_id'),
      name: optStr(d, 'name'),
      status: EVENT_STATUS[type] ?? optStr(d, 'status'),
      startsAt: optDate(d, 'starts_at'),
      endsAt: optDate(d, 'ends_at'),
    };
  }
  if (type === 'ActivityCreated' || type === 'ActivityUpdated') {
    return {
      kind: 'activity',
      activityId: reqStr(d, 'activity_id'),
      eventId: reqStr(d, 'event_id'),
      name: optStr(d, 'name'),
      capacity: optNum(d, 'capacity'),
      paid: optBool(d, 'paid'),
    };
  }
  if (Object.hasOwn(REGISTRATION_STATUS, type)) {
    return {
      kind: 'registration',
      registrationId: reqStr(d, 'registration_id'),
      eventId: reqEventIdFromSubscription(d),
      activityId: reqStr(d, 'activity_id'),
      userId: optStr(d, 'user_id'),
      status: REGISTRATION_STATUS[type],
    };
  }
  if (Object.hasOwn(PAYMENT_STATUS, type)) {
    return {
      kind: 'payment',
      paymentId: reqStr(d, 'payment_id'),
      registrationId: optStr(d, 'registration_id'),
      eventId: reqStr(d, 'event_id'),
      activityId: optStr(d, 'activity_id'),
      amount: optMinorAsDecimal(d, 'amount_minor'),
      currency: optStr(d, 'currency'),
      status: PAYMENT_STATUS[type],
    };
  }
  if (type === 'AttendanceRecorded') {
    return {
      kind: 'checkin',
      registrationId: reqStr(d, 'registration_id'),
      eventId: reqEventIdFromSubscription(d),
      activityId: reqStr(d, 'activity_id'),
      userId: optStr(d, 'user_id'),
    };
  }
  return { kind: 'ignored' };
}

export function parseMessage(raw: string): ParseResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return { ok: false, error: 'message must be a JSON object' };
  }
  const o = json as Record<string, unknown>;

  const messageId = typeof o.message_id === 'string' ? o.message_id.trim() : '';
  if (!messageId) return { ok: false, error: 'message_id is required' };
  const type = typeof o.type === 'string' ? o.type.trim() : '';
  if (!type) return { ok: false, error: 'type is required' };

  const version = o.schema_version === undefined ? 1 : o.schema_version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: 'schema_version must be a positive integer' };
  }
  if (version > 1) return { ok: false, error: `unsupported schema_version ${version} for ${type}` };

  if (typeof o.occurred_at !== 'string' || Number.isNaN(Date.parse(o.occurred_at))) {
    return { ok: false, error: 'occurred_at must be an ISO date' };
  }

  let change: Change;
  try {
    change = toChange(type, o);
  } catch (e) {
    return { ok: false, error: `${type}: ${(e as Error).message}` };
  }

  const traceId = typeof o.trace_id === 'string' && o.trace_id.trim() ? o.trace_id.trim() : null;
  return {
    ok: true,
    value: { envelope: { message_id: messageId, type, schema_version: version, occurred_at: o.occurred_at, trace_id: traceId }, change },
  };
}
