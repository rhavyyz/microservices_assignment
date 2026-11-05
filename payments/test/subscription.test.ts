import test from 'node:test';
import assert from 'node:assert/strict';
import type { request } from 'discovery';
import { createSubscriptionClient } from '../src/subscription.ts';

const reg = { registration_id: 'r1', user_id: 'u1', status: 'PENDING_PAYMENT', amount_minor: 2500, currency: 'brl', expires_at: '2030-01-01T00:00:00Z', event_id: null, activity_id: 'act-1' };
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Call = { method: string; kind: string; path: string; headers: Record<string, string> };

function fakeRequest(handler: (n: number) => Response | Error) {
  const calls: Call[] = [];
  const fn = (async (method: string, kind: string, path: string, opts?: { headers?: Record<string, string> }) => {
    calls.push({ method, kind, path, headers: opts?.headers ?? {} });
    const r = handler(calls.length);
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof request;
  return { fn, calls };
}

const client = (fn: typeof request) => createSubscriptionClient({ request: fn });

test('asks the lib for GET /internal/registrations/{id} of kind subscription and forwards X-Trace-Id', async () => {
  const f = fakeRequest(() => json(200, reg));
  const r = await client(f.fn)('r1', 'req-12345678');
  assert.equal(r.kind, 'found');
  assert.ok(r.kind === 'found' && r.registration.currency === 'BRL');
  assert.ok(r.kind === 'found' && r.registration.activity_id === 'act-1');
  assert.deepEqual(f.calls, [{ method: 'GET', kind: 'subscription', path: '/internal/registrations/r1', headers: { 'x-trace-id': 'req-12345678', accept: 'application/json' } }]);
});

test('404 is not_found; 5xx, odd statuses and invalid bodies are unavailable', async () => {
  const cases: [Response, string][] = [
    [json(404, { code: 'X' }), 'not_found'], [json(500, {}), 'unavailable'], [json(403, {}), 'unavailable'],
    [json(200, { ...reg, amount_minor: '2500' }), 'unavailable'], [json(200, { nope: 1 }), 'unavailable'],
    [json(200, { ...reg, event_id: 5 }), 'unavailable'],
    [json(200, { ...reg, activity_id: undefined }), 'unavailable'], [json(200, { ...reg, activity_id: '' }), 'unavailable'],
    [json(200, { ...reg, activity_id: 7 }), 'unavailable'], [json(200, { ...reg, status: 'CONFIRMED', expires_at: null, activity_id: undefined }), 'unavailable'],
    [json(200, { ...reg, expires_at: 'soon' }), 'unavailable'], [json(200, { ...reg, expires_at: '2030-13-45T00:00:00Z' }), 'unavailable'],
    [json(200, { ...reg, expires_at: '2030-01-01T00:00:00' }), 'unavailable'], [json(200, { ...reg, expires_at: 1893456000 }), 'unavailable'],
  ];
  for (const [res, kind] of cases) {
    const f = fakeRequest(() => res);
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
    const f = fakeRequest(() => json(200, body));
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
    const f = fakeRequest(() => json(200, body));
    assert.equal((await client(f.fn)('r1', 'rid')).kind, 'unavailable', JSON.stringify(body));
  }
});

test('a rejected request (consult failed, connection error) is unavailable with the error message', async () => {
  const f = fakeRequest(() => new Error('discoverer unreachable: ECONNREFUSED'));
  assert.deepEqual(await client(f.fn)('r1', 'rid'), { kind: 'unavailable', reason: 'discoverer unreachable: ECONNREFUSED' });
});
