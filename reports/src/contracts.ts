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
  // Moves the activity's lifecycle forward (never back); carries no descriptive fields.
  | { kind: 'activityLifecycle'; activityId: string; eventId: string; lifecycle: 'ENDED' | 'CANCELLED' | 'DELETED' }
  | { kind: 'registration'; registrationId: string; eventId: string; activityId: string; userId: string | null; status: string }
  // amountMinor is the producer's integer in minor units (cents), kept as is.
  | { kind: 'payment'; paymentId: string; registrationId: string | null; eventId: string; activityId: string | null; amountMinor: number | null; currency: string | null; status: string }
  | { kind: 'checkin'; registrationId: string; eventId: string; activityId: string; userId: string | null }
  | { kind: 'eligibility'; eventId: string; userId: string; registrationId: string | null; attendedActivities: number; totalActivities: number; attendancePercentage: number }
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

/** The producers' `amount_minor`: an integer in minor units (cents), non-negative and safe. */
function optMinor(d: Data, k: string): number | null {
  const v = d[k];
  if (v === undefined || v === null) return null;
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) {
    throw new Error(`${k} must be a non-negative integer (minor units)`);
  }
  return v;
}

/** A non-negative safe integer count. */
function reqCount(d: Data, k: string): number {
  const v = d[k];
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new Error(`${k} must be a non-negative integer`);
  return v;
}

const ACTIVITY_LIFECYCLE: Record<string, 'ENDED' | 'CANCELLED' | 'DELETED'> = {
  ActivityEnded: 'ENDED',
  ActivityCancelled: 'CANCELLED',
  ActivityDeleted: 'DELETED',
};

// A null status means "take it from status" (or keep the stored one).
const EVENT_STATUS: Record<string, string | null> = {
  EventCreated: null,
  EventUpdated: null,
  EventPublished: 'PUBLISHED',
  EventCancelled: 'CANCELLED',
};

const REGISTRATION_STATUS: Record<string, string> = {
  RegistrationWaitlisted: 'WAITLISTED',
  WaitlistOffered: 'OFFERED',
  RegistrationPendingPayment: 'PENDING_PAYMENT',
  RegistrationConfirmed: 'CONFIRMED',
  RegistrationCancelled: 'CANCELLED',
  RegistrationExpired: 'EXPIRED',
  RegistrationRejected: 'REJECTED',
};

const PAYMENT_STATUS: Record<string, string> = {
  PaymentCreated: 'PENDING',
  PaymentApproved: 'APPROVED',
  PaymentDeclined: 'DECLINED',
  PaymentExpired: 'EXPIRED',
  PaymentCancelled: 'CANCELLED',
  PaymentRefunded: 'REFUNDED',
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
  if (Object.hasOwn(ACTIVITY_LIFECYCLE, type)) {
    return {
      kind: 'activityLifecycle',
      activityId: reqStr(d, 'activity_id'),
      eventId: reqStr(d, 'event_id'),
      lifecycle: ACTIVITY_LIFECYCLE[type],
    };
  }
  if (type === 'AttendanceEligible') {
    const attended = reqCount(d, 'attended_activities');
    const total = reqCount(d, 'total_activities');
    if (total < 1) throw new Error('total_activities must be at least 1');
    if (attended > total) throw new Error('attended_activities must not exceed total_activities');
    const pct = d.attendance_percentage;
    if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new Error('attendance_percentage must be a number between 0 and 100');
    }
    return {
      kind: 'eligibility',
      eventId: reqStr(d, 'event_id'),
      userId: reqStr(d, 'user_id'),
      registrationId: optStr(d, 'registration_id'),
      attendedActivities: attended,
      totalActivities: total,
      attendancePercentage: pct,
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
      amountMinor: optMinor(d, 'amount_minor'),
      currency: optStr(d, 'currency'),
      status: PAYMENT_STATUS[type],
    };
  }
  if (type === 'AttendanceRecorded') {
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
