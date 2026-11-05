// Lookup of a registration in the Subscription service (GET /internal/registrations/{id}).
// The host comes from the service-discoverer (kind `subscription`); nothing is hardcoded.
import { config } from './config.ts';

export type Registration = {
  registration_id: string;
  user_id: string;
  status: string;
  amount_minor: number | null; // null/0 only outside PENDING_PAYMENT
  currency: string;
  expires_at: string | null; // Subscription sends null outside OFFERED/PENDING_PAYMENT
  event_id: string | null;
};

export type LookupResult =
  | { kind: 'found'; registration: Registration }
  | { kind: 'not_found' }
  | { kind: 'unavailable'; reason: string };

export type FetchRegistration = (id: string, traceId: string) => Promise<LookupResult>;

type Options = { discovererUrl?: string; fetchFn?: typeof fetch; timeoutMs?: number };

/** A connection-level failure: worth one retry after re-consulting the discoverer. */
class ConnectionFailure extends Error {}

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
  const rawExpires = o.expires_at;
  const amount = o.amount_minor;
  const event_id = o.event_id;
  if (!registration_id || !user_id || !status || !currency) return null;
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
  return { registration_id, user_id, status, amount_minor: isInt ? amount : null, currency: currency.toUpperCase(), expires_at, event_id: event_id ?? null };
}

export function createSubscriptionClient(opts: Options = {}): FetchRegistration {
  const doFetch = opts.fetchFn ?? fetch;
  const discovererUrl = opts.discovererUrl ?? config.discovererUrl;
  const timeoutMs = opts.timeoutMs ?? 5000;
  let cachedHost: string | null = null;

  async function consult(): Promise<string> {
    let res: Response;
    try {
      res = await doFetch(`${discovererUrl}/consult?kind=subscription`, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new Error(`discoverer unreachable: ${(e as Error).message}`);
    }
    if (res.status !== 200) throw new Error(`discoverer answered ${res.status}`);
    const body = (await res.json().catch(() => null)) as { host?: unknown } | null;
    if (!body || typeof body.host !== 'string' || body.host.trim() === '') throw new Error('discoverer returned no host');
    return body.host.trim();
  }

  async function attempt(host: string, id: string, traceId: string): Promise<LookupResult> {
    let res: Response;
    try {
      res = await doFetch(`http://${host}/internal/registrations/${encodeURIComponent(id)}`, {
        headers: { 'x-trace-id': traceId, accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ConnectionFailure((e as Error).message);
    }
    if (res.status === 404) return { kind: 'not_found' };
    if (res.status !== 200) return { kind: 'unavailable', reason: `subscription answered ${res.status}` };
    const registration = parseRegistration(await res.json().catch(() => null));
    if (!registration) return { kind: 'unavailable', reason: 'subscription returned an invalid body' };
    return { kind: 'found', registration };
  }

  return async (id, traceId) => {
    try {
      cachedHost ??= await consult();
      try {
        return await attempt(cachedHost, id, traceId);
      } catch (e) {
        if (!(e instanceof ConnectionFailure)) throw e;
        // The cached host may be stale (instance replaced): re-consult and retry once.
        cachedHost = null;
        cachedHost = await consult();
        return await attempt(cachedHost, id, traceId);
      }
    } catch (e) {
      if (e instanceof ConnectionFailure) cachedHost = null;
      return { kind: 'unavailable', reason: (e as Error).message };
    }
  };
}

export const fetchRegistration: FetchRegistration = createSubscriptionClient();
