// Lookup of a registration in the Subscription service (GET /internal/registrations/{id}).
// The host comes from the service-discoverer (kind `subscription`) through the shared `discovery` lib; nothing is hardcoded.
import { Kind, request } from 'discovery';

export type Registration = {
  registration_id: string;
  user_id: string;
  status: string;
  amount_minor: number | null; // null/0 only outside PENDING_PAYMENT
  currency: string;
  expires_at: string | null; // Subscription sends null outside OFFERED/PENDING_PAYMENT
  event_id: string | null;
  activity_id: string;
};

export type LookupResult =
  | { kind: 'found'; registration: Registration }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: string };

export type FetchRegistration = (id: string, traceId: string) => Promise<LookupResult>;

type RequestFn = typeof request;
type Options = { request?: RequestFn };

// ISO 8601 date-time with an explicit offset (Z or +hh:mm); Date.parse alone accepts far looser input.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function parseRegistration(b: unknown): Registration | null {
  if (typeof b !== 'object' || b === null) return null;
  const o = b as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === 'string' && o[k] !== '' ? (o[k] as string) : null);
  const registration_id = s('registration_id');
  const user_id = s('user_id');
  const status = s('status');
  const currency = s('currency');
  const activity_id = s('activity_id');
  const rawExpires = o.expires_at;
  const amount = o.amount_minor;
  const event_id = o.event_id;
  if (!registration_id || !user_id || !status || !currency || !activity_id) return null;
  const pending = status === 'PENDING_PAYMENT';
  const isInt = typeof amount === 'number' && Number.isSafeInteger(amount);
  // Only a payable registration needs a positive amount; others may be free (0) or carry none.
  if (pending) {
    if (!isInt || amount <= 0) return null;
  } else if (amount !== undefined && amount !== null && (!isInt || amount < 0)) return null;
  let expires_at: string | null = null;
  if (rawExpires !== undefined && rawExpires !== null) {
    if (typeof rawExpires !== 'string' || !ISO_INSTANT.test(rawExpires) || Number.isNaN(Date.parse(rawExpires))) return null;
    expires_at = rawExpires;
  }
  if (pending && expires_at === null) return null; // the deadline check needs it
  if (event_id !== undefined && event_id !== null && typeof event_id !== 'string') return null;
  return { registration_id, user_id, status, amount_minor: isInt ? amount : null, currency: currency.toUpperCase(), expires_at, event_id: event_id ?? null, activity_id };
}

export function createSubscriptionClient(opts: Options = {}): FetchRegistration {
  const doRequest = opts.request ?? request;

  return async (id, traceId) => {
    try {
      const res = await doRequest('GET', Kind.SUBSCRIPTION, `/internal/registrations/${encodeURIComponent(id)}`, {
        headers: { 'x-trace-id': traceId, accept: 'application/json' },
      });
      if (res.status === 404) return { kind: 'not_found' };
      if (res.status !== 200) return { kind: 'unavailable', reason: `subscription answered ${res.status}` };
      const registration = parseRegistration(await res.json().catch(() => null));
      if (!registration) return { kind: 'unavailable', reason: 'subscription returned an invalid body' };
      return { kind: 'found', registration };
    } catch (e) {
      // Consult failed after the lib's own retry, or the host stayed unreachable.
      return { kind: 'unavailable', reason: (e as Error).message };
    }
  };
}

export const fetchRegistration: FetchRegistration = createSubscriptionClient();
