// Server-side discovery through the service-discoverer, raw protocol (there is no TypeScript lib):
//   POST /register {"kind","host"} -> 204        GET /consult?kind=<kind> -> 200 {"host"}
import { backoffDelay, sleep } from './retry.ts';

export type DiscoveryOptions = {
  url: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
};

const TIMEOUT_MS = 5000;
const ATTEMPTS = 10; // ~2.5 minutes in all, the same policy as the Go/Python/Java libs

/** Registers this instance, retrying with backoff; throws after the last attempt. */
export async function register(kind: string, host: string, opts: DiscoveryOptions): Promise<void> {
  const doFetch = opts.fetchFn ?? fetch;
  const wait = opts.sleep ?? sleep;
  let lastError = 'unknown error';
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const res = await doFetch(`${opts.url}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, host }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status >= 200 && res.status < 300) return;
      lastError = `discoverer answered ${res.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
    if (attempt < ATTEMPTS - 1) {
      const delay = backoffDelay(attempt);
      opts.log?.(`register as ${kind} failed (${lastError}); retrying in ${delay}ms`);
      await wait(delay);
    }
  }
  throw new Error(`could not register as ${kind}: ${lastError}`);
}

/** Asks for a healthy instance of `kind` ("host:port"); no caching, one attempt. */
export async function consult(kind: string, opts: DiscoveryOptions): Promise<string> {
  const doFetch = opts.fetchFn ?? fetch;
  const res = await doFetch(`${opts.url}/consult?kind=${encodeURIComponent(kind)}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (res.status !== 200) throw new Error(`no ${kind} instance (discoverer answered ${res.status})`);
  const body = (await res.json()) as { host?: unknown };
  if (typeof body.host !== 'string' || !body.host) throw new Error('discoverer answered without a host');
  return body.host;
}
