// Event contract consumed by the reports service. See README.md ("Event contract").

export type Envelope = {
  message_id: string;
  type: string;
  version: number;
  occurred_at: string;
  correlation_id: string | null;
};

export type Change =
  | { kind: 'event'; eventId: string; organizerId: string | null; name: string | null; status: string | null; startsAt: string | null; endsAt: string | null }
  | { kind: 'activity'; activityId: string; eventId: string; name: string | null; capacity: number | null; paid: boolean | null }
  | { kind: 'registration'; registrationId: string; eventId: string; activityId: string; userId: string | null; status: string }
  | { kind: 'payment'; paymentId: string; registrationId: string | null; eventId: string; activityId: string | null; amount: number | null; currency: string | null; status: string }
  | { kind: 'checkin'; registrationId: string; eventId: string; activityId: string; userId: string | null }
  | { kind: 'ignored' };

export type Parsed = { envelope: Envelope; change: Change };
export type ParseResult = { ok: true; value: Parsed } | { ok: false; error: string };

type Data = Record<string, unknown>;

function reqStr(d: Data, k: string): string {
  const v = d[k];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`data.${k} is required`);
  return v.trim();
}

function optStr(d: Data, k: string): string | null {
  const v = d[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new Error(`data.${k} must be a string`);
  const t = v.trim();
  return t === '' ? null : t;
}

function optNum(d: Data, k: string): number | null {
  const v = d[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`data.${k} must be a number`);
  return v;
}

function optBool(d: Data, k: string): boolean | null {
  const v = d[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'boolean') throw new Error(`data.${k} must be a boolean`);
  return v;
}

function optDate(d: Data, k: string): string | null {
  const s = optStr(d, k);
  if (s === null) return null;
  if (Number.isNaN(Date.parse(s))) throw new Error(`data.${k} must be an ISO date`);
  return s;
}

// A null status means "take it from data.status" (or keep the stored one).
const EVENT_STATUS: Record<string, string | null> = {
  'event.created': null,
  'event.updated': null,
  'event.published': 'PUBLISHED',
  'event.cancelled': 'CANCELLED',
};

const REGISTRATION_STATUS: Record<string, string> = {
  'registration.requested': 'PENDING',
  'registration.confirmed': 'CONFIRMED',
  'registration.waitlisted': 'WAITLISTED',
  'registration.cancelled': 'CANCELLED',
  'registration.expired': 'EXPIRED',
};

const PAYMENT_STATUS: Record<string, string> = {
  'payment.created': 'PENDING',
  'payment.confirmed': 'CONFIRMED',
  'payment.refused': 'REFUSED',
  'payment.expired': 'EXPIRED',
  'payment.cancelled': 'CANCELLED',
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
  if (type === 'activity.created' || type === 'activity.updated') {
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
      eventId: reqStr(d, 'event_id'),
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
      amount: optNum(d, 'amount'),
      currency: optStr(d, 'currency'),
      status: PAYMENT_STATUS[type],
    };
  }
  if (type === 'checkin.registered') {
    return {
      kind: 'checkin',
      registrationId: reqStr(d, 'registration_id'),
      eventId: reqStr(d, 'event_id'),
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

  const version = o.version === undefined ? 1 : o.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: 'version must be a positive integer' };
  }
  if (version > 1) return { ok: false, error: `unsupported version ${version} for ${type}` };

  if (typeof o.occurred_at !== 'string' || Number.isNaN(Date.parse(o.occurred_at))) {
    return { ok: false, error: 'occurred_at must be an ISO date' };
  }
  if (typeof o.data !== 'object' || o.data === null || Array.isArray(o.data)) {
    return { ok: false, error: 'data must be an object' };
  }

  let change: Change;
  try {
    change = toChange(type, o.data as Data);
  } catch (e) {
    return { ok: false, error: `${type}: ${(e as Error).message}` };
  }

  const correlationId = typeof o.correlation_id === 'string' && o.correlation_id.trim() ? o.correlation_id.trim() : null;
  return {
    ok: true,
    value: { envelope: { message_id: messageId, type, version, occurred_at: o.occurred_at, correlation_id: correlationId }, change },
  };
}
