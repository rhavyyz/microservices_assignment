// Input validation: the REST body of POST /payments and the messages read from the subscription topic.

export type CreateInput = {
  registrationId: string;
  userId: string;
  eventId: string;
  activityId: string;
  amount: number;
  currency: string;
  expiresAt: Date;
};

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

function reqStr(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== 'string' || v.trim() === '') throw new Error(`${k} is required`);
  const t = v.trim();
  if (t.length > 200) throw new Error(`${k} is too long`);
  return t;
}

export function validateCreate(body: unknown, now: Date): Validation<CreateInput> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  const o = body as Record<string, unknown>;
  try {
    const amount = o.amount;
    if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
      throw new Error('amount must be a number greater than 0');
    }
    if (amount > 9999999999 || Math.abs(amount * 100 - Math.round(amount * 100)) > 1e-6) {
      throw new Error('amount must have at most 2 decimals and fit in 10 digits');
    }
    const currencyRaw = o.currency === undefined || o.currency === null ? 'BRL' : o.currency;
    if (typeof currencyRaw !== 'string' || !/^[A-Za-z]{3}$/.test(currencyRaw.trim())) {
      throw new Error('currency must be a 3-letter code');
    }
    const exp = o.expires_at;
    if (typeof exp !== 'string' || Number.isNaN(Date.parse(exp))) throw new Error('expires_at must be an ISO date');
    const expiresAt = new Date(exp);
    if (expiresAt.getTime() <= now.getTime()) throw new Error('expires_at must be in the future');
    return {
      ok: true,
      value: {
        registrationId: reqStr(o, 'registration_id'),
        userId: reqStr(o, 'user_id'),
        eventId: reqStr(o, 'event_id'),
        activityId: reqStr(o, 'activity_id'),
        amount,
        currency: currencyRaw.trim().toUpperCase(),
        expiresAt,
      },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export type Inbound = {
  messageId: string;
  type: string;
  correlationId: string | null;
  // Set only for messages that must cancel a pending payment.
  cancel: { registrationId: string; reason: string } | null;
};

const CANCEL_REASONS: Record<string, string> = {
  'registration.cancelled': 'registration_cancelled',
  'registration.expired': 'registration_expired',
};

export function parseSubscriptionMessage(raw: string): Validation<Inbound> {
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
  if (typeof o.data !== 'object' || o.data === null || Array.isArray(o.data)) {
    return { ok: false, error: 'data must be an object' };
  }
  const correlationId = typeof o.correlation_id === 'string' && o.correlation_id.trim() ? o.correlation_id.trim() : null;

  if (!Object.hasOwn(CANCEL_REASONS, type)) return { ok: true, value: { messageId, type, correlationId, cancel: null } };
  const rid = (o.data as Record<string, unknown>).registration_id;
  if (typeof rid !== 'string' || rid.trim() === '') return { ok: false, error: `${type}: data.registration_id is required` };
  return { ok: true, value: { messageId, type, correlationId, cancel: { registrationId: rid.trim(), reason: CANCEL_REASONS[type] } } };
}
