// Registration in the service-discoverer, raw protocol: POST /register {"kind","host"} -> 204.
// Same retry policy as the shared libs: 10 attempts, 1s doubling up to a 30s cap (~2.5 min in all).

export function backoffDelays(attempts = 10, baseMs = 1000, capMs = 30000): number[] {
  const delays: number[] = [];
  for (let i = 0; i < attempts - 1; i++) delays.push(Math.min(capMs, baseMs * 2 ** i));
  return delays;
}

type Options = {
  url: string;
  host: string;
  fetchFn?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
};

export async function registerService(kind: string, opts: Options): Promise<void> {
  const doFetch = opts.fetchFn ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delays = backoffDelays();
  let lastError = 'unknown error';

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await doFetch(`${opts.url}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind, host: opts.host }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.status >= 200 && res.status < 300) return;
      lastError = `discoverer answered ${res.status}`;
    } catch (e) {
      lastError = (e as Error).message;
    }
    if (attempt < delays.length) {
      opts.log?.(`register as ${kind} failed (${lastError}); retrying in ${delays[attempt]}ms`);
      await sleep(delays[attempt]);
    }
  }
  throw new Error(`could not register as ${kind}: ${lastError}`);
}
