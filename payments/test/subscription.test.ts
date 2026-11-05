import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionClient } from '../src/subscription.ts';

const reg = { registration_id: 'r1', user_id: 'u1', status: 'PENDING_PAYMENT', amount_minor: 2500, currency: 'brl', expires_at: '2030-01-01T00:00:00Z', parent_event_id: null };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; headers: Record<string, string> };

function fakeFetch(handler: (url: string, n: number) => Response | Error) {
  const calls: Call[] = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    const r = handler(url, calls.length);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const client = (fn: typeof fetch) => createSubscriptionClient({ discovererUrl: 'http://disc:1', fetchFn: fn, timeoutMs: 50 });

test('consults the discoverer for kind subscription, forwards X-Request-Id, caches the host', async () => {
  const f = fakeFetch((url) => (url.includes('/consult') ? json(200, { host: 'sub-1:8000' }) : json(200, reg)));
  const lookup = client(f.fn);
  const r = await lookup('r1', 'req-12345678');
  assert.equal(r.kind, 'found');
  assert.ok(r.kind === 'found' && r.registration.currency === 'BRL');
  assert.equal(f.calls[0].url, 'http://disc:1/consult?kind=subscription');
  assert.equal(f.calls[1].url, 'http://sub-1:8000/internal/registrations/r1');
  assert.equal(f.calls[1].headers['x-request-id'], 'req-12345678');
  await lookup('r1', 'req-12345678');
  assert.equal(f.calls.filter((c) => c.url.includes('/consult')).length, 1);
});

test('404 is not_found; 5xx, odd statuses and invalid bodies are unavailable', async () => {
  const cases: [Response, string][] = [
    [json(404, { code: 'X' }), 'not_found'], [json(500, {}), 'unavailable'], [json(403, {}), 'unavailable'],
    [json(200, { ...reg, amount_minor: '2500' }), 'unavailable'], [json(200, { nope: 1 }), 'unavailable'],
    [json(200, { ...reg, parent_event_id: 5 }), 'unavailable'],
    [json(200, { ...reg, expires_at: 'soon' }), 'unavailable'], [json(200, { ...reg, expires_at: '2030-13-45T00:00:00Z' }), 'unavailable'],
    [json(200, { ...reg, expires_at: '2030-01-01T00:00:00' }), 'unavailable'], [json(200, { ...reg, expires_at: 1893456000 }), 'unavailable'],
  ];
  for (const [res, kind] of cases) {
    const f = fakeFetch((url) => (url.includes('/consult') ? json(200, { host: 'h:1' }) : res));
    assert.equal((await client(f.fn)('r1', 'rid')).kind, kind);
  }
});

test('non-pending registrations may have null/absent expires_at and a null or zero amount', async () => {
  const cases = [
    { ...reg, status: 'CONFIRMED', expires_at: null },
    { ...reg, status: 'CANCELLED', expires_at: null, amount_minor: 0 },
    { ...reg, status: 'EXPIRED', expires_at: undefined, amount_minor: null },
  ];
  for (const body of cases) {
    const f = fakeFetch((url) => (url.includes('/consult') ? json(200, { host: 'h:1' }) : json(200, body)));
    const r = await client(f.fn)('r1', 'rid');
    assert.equal(r.kind, 'found');
    if (r.kind === 'found') assert.equal(r.registration.expires_at, null);
  }
});

test('PENDING_PAYMENT without expires_at or positive amount, and garbage expires_at on any status, are unavailable', async () => {
  const bodies = [
    { ...reg, expires_at: null }, { ...reg, expires_at: undefined }, { ...reg, amount_minor: 0 }, { ...reg, amount_minor: null },
    { ...reg, status: 'CONFIRMED', expires_at: 'soon' }, { ...reg, status: 'CANCELLED', expires_at: 123 },
    { ...reg, status: 'CONFIRMED', amount_minor: -1 },
  ];
  for (const body of bodies) {
    const f = fakeFetch((url) => (url.includes('/consult') ? json(200, { host: 'h:1' }) : json(200, body)));
    assert.equal((await client(f.fn)('r1', 'rid')).kind, 'unavailable', JSON.stringify(body));
  }
});

test('connection failure re-consults the discoverer and retries once', async () => {
  const hosts = ['old:1', 'new:2'];
  const f = fakeFetch((url) => {
    if (url.includes('/consult')) return json(200, { host: hosts.shift() });
    return url.startsWith('http://old:1') ? new Error('ECONNREFUSED') : json(200, reg);
  });
  const r = await client(f.fn)('r1', 'rid');
  assert.equal(r.kind, 'found');
  assert.deepEqual(f.calls.map((c) => c.url), [
    'http://disc:1/consult?kind=subscription', 'http://old:1/internal/registrations/r1',
    'http://disc:1/consult?kind=subscription', 'http://new:2/internal/registrations/r1',
  ]);
});

test('still failing after the retry, or discoverer down, is unavailable', async () => {
  const down = fakeFetch((url) => (url.includes('/consult') ? json(200, { host: 'h:1' }) : new Error('ECONNREFUSED')));
  assert.equal((await client(down.fn)('r1', 'rid')).kind, 'unavailable');
  assert.equal(down.calls.length, 4); // consult, try, consult, retry
  for (const mk of [() => new Error('boom'), () => json(503, {}), () => json(200, {}), () => json(200, { host: '' })]) {
    const f = fakeFetch(mk);
    assert.equal((await client(f.fn)('r1', 'rid')).kind, 'unavailable');
  }
});
