import { hostname } from "node:os";
import { Kind } from "./kinds.ts";

export const REGISTER_ATTEMPTS = 10;
export const REGISTER_INITIAL_DELAY = 1000; // ms
export const REGISTER_MAX_DELAY = 30000; // ms
export const TIMEOUT = 5000; // ms, per call

export type RequestOptions = { headers?: Record<string, string>; body?: unknown };

// Everything a test may replace. The defaults are the real fetch, setTimeout and process.env.
export type ClientDeps = {
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  env?: Record<string, string | undefined>;
};

export type Client = {
  register(kind: Kind): Promise<void>;
  consult(kind: Kind): Promise<string>;
  request(method: string, kind: Kind, url: string, options?: RequestOptions): Promise<Response>;
};

// One cache per kind for a client. `pending` is the consult in flight, shared by concurrent callers.
type KindCache = { host?: string; pending?: Promise<string> };

export function createClient(deps: ClientDeps = {}): Client {
  const doFetch = deps.fetchFn ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const env = () => deps.env ?? process.env;
  const caches = new Map<Kind, KindCache>();

  const discovererUrl = () =>
    (env().SERVICE_DISCOVERER_URL || "http://service-discoverer:8080").replace(/\/+$/, "");

  // Plain HTTP call. HTTP error statuses are returned; only transport errors reject.
  const send = (method: string, url: string, headers: Record<string, string>, body?: string) =>
    doFetch(url, { method: method.toUpperCase(), headers, body, signal: AbortSignal.timeout(TIMEOUT) });

  // Registers this instance. Call once at startup, passing only its own kind.
  // The host sent is SERVICE_HOST, or "<container hostname>:<PORT or 8080>".
  // Retries up to 10 times with a delay doubling from 1s up to 30s (about 2.5 minutes
  // in all). It is async, so it does not block the event loop, but do not await it before
  // listening: call `register(kind).catch(...)` and keep starting the service.
  async function register(kind: Kind): Promise<void> {
    const host = env().SERVICE_HOST || `${hostname()}:${env().PORT || "8080"}`;
    const payload = JSON.stringify({ kind, host });
    let last: unknown;
    let delay = REGISTER_INITIAL_DELAY;
    for (let attempt = 0; attempt < REGISTER_ATTEMPTS; attempt++) {
      if (attempt) {
        await sleep(delay);
        delay = Math.min(delay * 2, REGISTER_MAX_DELAY);
      }
      try {
        const res = await send("POST", `${discovererUrl()}/register`, { "Content-Type": "application/json" }, payload);
        const text = await res.text();
        if (res.status >= 200 && res.status < 300) return;
        last = new Error(`register failed: ${res.status} ${text.trim()}`);
      } catch (e) {
        last = e;
      }
    }
    throw new Error(`could not register with the service-discoverer: ${(last as Error).message}`);
  }

  // Asks the service-discoverer for a healthy host of `kind`. No caching.
  async function consult(kind: Kind): Promise<string> {
    const res = await send("GET", `${discovererUrl()}/consult?kind=${encodeURIComponent(kind)}`, {});
    if (res.status !== 200) throw new Error(`consult ${kind} failed: ${res.status} ${(await res.text()).trim()}`);
    return ((await res.json()) as { host: string }).host;
  }

  // Returns the cached host, asking the discoverer if there is none or it is `stale`.
  // Concurrent callers share one consult.
  function resolve(kind: Kind, stale?: string): Promise<string> {
    let cache = caches.get(kind);
    if (!cache) caches.set(kind, (cache = {}));
    const c = cache;
    if (c.pending) return c.pending;
    if (c.host !== undefined && c.host !== stale) return Promise.resolve(c.host);
    c.pending = consult(kind)
      .then((host) => (c.host = host))
      .finally(() => (c.pending = undefined));
    return c.pending;
  }

  // Calls `url` (a path like "/charge") on an instance of `kind`.
  // options: {headers, body}, both optional; body is sent as JSON.
  // If the cached host is unreachable, the host is rediscovered and the call retried once.
  // Resolves to the platform Response (status, headers, text(), json()).
  async function request(method: string, kind: Kind, url: string, options: RequestOptions = {}): Promise<Response> {
    const headers = { ...options.headers };
    let body: string | undefined;
    if (options.body !== undefined && options.body !== null) {
      body = JSON.stringify(options.body);
      if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
        headers["Content-Type"] = "application/json";
      }
    }
    const path = url.startsWith("/") ? url : "/" + url;

    let host = await resolve(kind);
    try {
      return await send(method, `http://${host}${path}`, headers, body);
    } catch {
      // connection refused, timeout, DNS
      host = await resolve(kind, host);
      return await send(method, `http://${host}${path}`, headers, body);
    }
  }

  return { register, consult, request };
}

const defaultClient = createClient();

export const register = defaultClient.register;
export const consult = defaultClient.consult;
export const request = defaultClient.request;
