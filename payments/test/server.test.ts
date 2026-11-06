import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildServer } from '../src/server.ts';
import type { FetchRegistration, Registration } from '../src/subscription.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const PID = '33333333-3333-4333-8333-333333333333';

const row = (over: object = {}) => ({
  payment_id: PID, registration_id: 'r1', user_id: USER, event_id: 'e1', activity_id: 'act-1',
  amount_minor: '2500', currency: 'BRL', status: 'APPROVED',
  expires_at: new Date('2030-01-01T00:00:00Z'), created_at: new Date('2026-01-01T00:00:00Z'), ...over,
});

// Fake pool: every query returns `rows` (or what onQuery says); BEGIN/COMMIT/ROLLBACK return nothing. No database needed.
function fakePool(rows: object[] = [], onQuery?: (sql: string) => object[] | undefined): Pool {
  const query = async (sql: string) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    const r = onQuery?.(sql) ?? rows;
    return { rows: r, rowCount: r.length };
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

async function app(pool: Pool = fakePool()) {
  const a = await buildServer(pool);
  a.log.level = 'silent';
  return a;
}

type Res = { statusCode: number; headers: Record<string, unknown>; json: () => any };

function assertProblem(res: Res, status: number, code: string) {
  assert.equal(res.statusCode, status);
  assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
  const b = res.json();
  assert.equal(b.status, status);
  assert.equal(b.code, code);
  assert.equal(typeof b.title, 'string');
  assert.equal(b.traceId, res.headers['x-trace-id']);
  return b;
}


test('X-Trace-Id: valid value is kept and echoed', async () => {
  const a = await app();
  const res = await a.inject({ method: 'GET', url: '/payments/' + PID, headers: { 'x-trace-id': 'req-1234.abc_X', 'x-user-id': USER } });
  assert.equal(res.headers['x-trace-id'], 'req-1234.abc_X');
});

test('X-Trace-Id: missing or invalid values are replaced by a UUID', async () => {
  const a = await app();
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  for (const bad of [undefined, 'short', 'x'.repeat(65), 'has space in it', 'bad/char/here!']) {
    const res = await a.inject({ method: 'GET', url: '/healthcheck', headers: bad === undefined ? {} : { 'x-trace-id': bad } });
    assert.match(String(res.headers['x-trace-id']), uuid, `generated for ${String(bad)}`);
  }
  const edge = await a.inject({ method: 'GET', url: '/healthcheck', headers: { 'x-trace-id': 'x'.repeat(64) } });
  assert.equal(edge.headers['x-trace-id'], 'x'.repeat(64));
  const old = await a.inject({ method: 'GET', url: '/healthcheck', headers: { 'x-correlation-id': 'corr-12345678' } });
  assert.notEqual(old.headers['x-trace-id'], 'corr-12345678');
  assert.equal(old.headers['x-correlation-id'], undefined);
  const legacy = await a.inject({ method: 'GET', url: '/healthcheck', headers: { 'x-request-id': 'valid-old-id-12345' } });
  assert.match(String(legacy.headers['x-trace-id']), uuid);
  assert.notEqual(legacy.headers['x-trace-id'], 'valid-old-id-12345');
  assert.equal(legacy.headers['x-request-id'], undefined);
});

test('401 UNAUTHENTICATED when X-User-Id is missing or not a UUID', async () => {
  const a = await app();
  for (const headers of [{}, { 'x-user-id': 'u1' }, { 'x-user-id': '   ' }]) {
    const res = await a.inject({ method: 'GET', url: '/payments/' + PID, headers });
    assertProblem(res, 401, 'UNAUTHENTICATED');
  }
  const res = await a.inject({ method: 'GET', url: '/payments?registration_id=r1', headers: { 'x-user-id': 'not-a-uuid' } });
  assertProblem(res, 401, 'UNAUTHENTICATED');
});

test("404 PAYMENT_NOT_FOUND for unknown id, bad id and someone else's payment", async () => {
  const a = await app(fakePool([row()]));
  const other = await a.inject({ method: 'GET', url: '/payments/' + PID, headers: { 'x-user-id': OTHER } });
  assertProblem(other, 404, 'PAYMENT_NOT_FOUND');
  const badId = await a.inject({ method: 'GET', url: '/payments/nope', headers: { 'x-user-id': USER } });
  assertProblem(badId, 404, 'PAYMENT_NOT_FOUND');
  const none = await (await app(fakePool([]))).inject({ method: 'GET', url: '/payments/' + PID, headers: { 'x-user-id': USER } });
  assertProblem(none, 404, 'PAYMENT_NOT_FOUND');
  const mine = await a.inject({ method: 'GET', url: '/payments/' + PID, headers: { 'x-user-id': USER } });
  assert.equal(mine.statusCode, 200);
  assert.equal(mine.json().status, 'APPROVED');
  assert.equal(mine.json().amount_minor, 2500);
});

test('unknown route is a problem+json 404', async () => {
  const res = await (await app()).inject({ method: 'GET', url: '/nothing' });
  assertProblem(res, 404, 'NOT_FOUND');
});

const REG = '44444444-4444-4444-8444-444444444444';
const registration = (over: object = {}): Registration => ({
  registration_id: REG, user_id: USER, status: 'PENDING_PAYMENT', amount_minor: 4200, currency: 'USD',
  expires_at: '2999-01-01T00:00:00Z', event_id: 'ev-9', activity_id: 'act-7', ...over,
});
const found = (over: object = {}): FetchRegistration => async () => ({ kind: 'found', registration: registration(over) });

// Pool for POST /payments: SELECT by registration returns `existing`; INSERT returns the created row (and records its params).
function createPool(existing: object[] = [], inserted: { params?: unknown[] } = {}): Pool {
  const query = async (sql: string, params?: unknown[]) => {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (/^\s*INSERT INTO payments/.test(sql)) {
      inserted.params = params;
      const r = [row({ registration_id: REG, status: 'PENDING', amount_minor: String(params![5]), currency: params![6], user_id: params![2], event_id: params![3], activity_id: params![4], expires_at: params![7] })];
      return { rows: r, rowCount: 1 };
    }
    if (/^\s*SELECT/.test(sql)) return { rows: existing, rowCount: existing.length };
    return { rows: [], rowCount: 0 };
  };
  return { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
}

const post = (a: Awaited<ReturnType<typeof app>>, payload: unknown, headers: Record<string, string> = { 'x-user-id': USER }) =>
  a.inject({ method: 'POST', url: '/payments', headers, payload: payload as object });

test('POST /payments: 201, amount/currency/user/event_id/activity_id come from Subscription, own TTL, client body ignored', async () => {
  const inserted: { params?: unknown[] } = {};
  let seen: { id: string; rid: string } | undefined;
  const lookup: FetchRegistration = async (id, rid) => { seen = { id, rid }; return { kind: 'found', registration: registration() }; };
  const before = Date.now();
  const a = await buildServer(createPool([], inserted), lookup);
  a.log.level = 'silent';
  const res = await post(a, { registration_id: REG, user_id: OTHER, amount_minor: 1, currency: 'EUR', event_id: 'x', activity_id: 'client-act', expires_at: '2000-01-01T00:00:00Z' },
    { 'x-user-id': USER, 'x-trace-id': 'req-abcdef12' });
  assert.equal(res.statusCode, 201);
  const b = res.json();
  assert.equal(b.status, 'PENDING');
  assert.equal(b.user_id, USER);
  assert.equal(b.amount_minor, 4200);
  assert.equal(b.currency, 'USD');
  assert.equal(b.event_id, 'ev-9');
  assert.equal(b.activity_id, 'act-7');
  assert.equal(inserted.params![4], 'act-7');
  assert.deepEqual(seen, { id: REG, rid: 'req-abcdef12' });
  const exp = new Date(b.expires_at).getTime();
  assert.ok(exp >= before + 900_000 - 1000 && exp <= Date.now() + 900_000 + 1000);
});

test('POST /payments: null event_id is stored as NULL', async () => {
  const inserted: { params?: unknown[] } = {};
  const a = await buildServer(createPool([], inserted), found({ event_id: null }));
  a.log.level = 'silent';
  const res = await post(a, { registration_id: REG });
  assert.equal(res.statusCode, 201);
  assert.equal(inserted.params![3], null);
  assert.equal(res.json().event_id, null);
});

test('POST /payments: a lookup without activity_id is an invalid upstream body, 503', async () => {
  const { createSubscriptionClient } = await import('../src/subscription.ts');
  const body = { registration_id: REG, user_id: USER, status: 'PENDING_PAYMENT', amount_minor: 100, currency: 'USD', expires_at: '2999-01-01T00:00:00Z', event_id: null };
  const fn = (async () => new Response(JSON.stringify(body), { status: 200 })) as never;
  const a = await buildServer(createPool(), createSubscriptionClient({ request: fn }));
  a.log.level = 'silent';
  assertProblem(await post(a, { registration_id: REG }), 503, 'UPSTREAM_UNAVAILABLE');
});

test('POST /payments: 404 REGISTRATION_NOT_FOUND for unknown and for someone else\'s registration', async () => {
  const a1 = await buildServer(createPool(), async () => ({ kind: 'not_found' }));
  a1.log.level = 'silent';
  assertProblem(await post(a1, { registration_id: REG }), 404, 'REGISTRATION_NOT_FOUND');
  const a2 = await buildServer(createPool(), found({ user_id: OTHER }));
  a2.log.level = 'silent';
  assertProblem(await post(a2, { registration_id: REG }), 404, 'REGISTRATION_NOT_FOUND');
});

test('POST /payments: 409 REGISTRATION_NOT_PAYABLE when the registration is not PENDING_PAYMENT', async () => {
  for (const status of ['CONFIRMED', 'CANCELLED', 'EXPIRED']) {
    const a = await buildServer(createPool(), found({ status }));
    a.log.level = 'silent';
    assertProblem(await post(a, { registration_id: REG }), 409, 'REGISTRATION_NOT_PAYABLE');
  }
});

const NOW = new Date('2026-06-01T12:00:00Z');
const clocked = async (pool: Pool, lookup: FetchRegistration) => {
  const a = await buildServer(pool, lookup, () => NOW);
  a.log.level = 'silent';
  return a;
};

test('POST /payments: 409 (not 503) for non-pending registrations with null expires_at / zero amount', async () => {
  for (const over of [{ status: 'CONFIRMED', expires_at: null }, { status: 'CANCELLED', expires_at: null, amount_minor: 0 }]) {
    const a = await clocked(createPool(), found(over));
    assertProblem(await post(a, { registration_id: REG }), 409, 'REGISTRATION_NOT_PAYABLE');
  }
});

test('POST /payments: end to end through the client, null expires_at is 409 when CONFIRMED, 503 when PENDING_PAYMENT or garbage', async () => {
  const { createSubscriptionClient } = await import('../src/subscription.ts');
  const body = { registration_id: REG, user_id: USER, status: 'PENDING_PAYMENT', amount_minor: 100, currency: 'USD', event_id: null, activity_id: 'act-1' };
  const cases: [object, number, string][] = [
    [{ status: 'CONFIRMED', expires_at: null }, 409, 'REGISTRATION_NOT_PAYABLE'],
    [{ status: 'CANCELLED', expires_at: null, amount_minor: 0 }, 409, 'REGISTRATION_NOT_PAYABLE'],
    [{ expires_at: null }, 503, 'UPSTREAM_UNAVAILABLE'],
    [{ status: 'CONFIRMED', expires_at: 'garbage' }, 503, 'UPSTREAM_UNAVAILABLE'],
  ];
  for (const [over, status, code] of cases) {
    const fn = (async () => new Response(JSON.stringify({ ...body, ...over }), { status: 200 })) as never;
    const a = await clocked(createPool(), createSubscriptionClient({ request: fn }));
    assertProblem(await post(a, { registration_id: REG }), status, code);
  }
});

test('POST /payments: 409 REGISTRATION_NOT_PAYABLE when the reservation deadline passed or is exactly now, no INSERT', async () => {
  for (const expires_at of ['2026-06-01T11:59:59Z', '2026-06-01T12:00:00Z', '2026-06-01T09:00:00-03:00']) {
    const inserted: { params?: unknown[] } = {};
    const a = await clocked(createPool([], inserted), found({ expires_at }));
    const b = assertProblem(await post(a, { registration_id: REG }), 409, 'REGISTRATION_NOT_PAYABLE');
    assert.match(b.detail, /expired/);
    assert.equal(inserted.params, undefined, expires_at);
  }
});

test('POST /payments: 201 when the reservation deadline is still in the future', async () => {
  const a = await clocked(createPool(), found({ expires_at: '2026-06-01T12:00:01Z' }));
  assert.equal((await post(a, { registration_id: REG })).statusCode, 201);
});

test('POST /payments: foreign owner with an expired registration still gets 404', async () => {
  const a = await clocked(createPool(), found({ user_id: OTHER, expires_at: '2026-06-01T11:00:00Z' }));
  assertProblem(await post(a, { registration_id: REG }), 404, 'REGISTRATION_NOT_FOUND');
});

test('POST /payments: an existing payment after the deadline is still 200 and Subscription is not called', async () => {
  const a = await clocked(createPool([row({ registration_id: REG, status: 'PENDING' })]), async () => { throw new Error('must not be called'); });
  const res = await post(a, { registration_id: REG });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'PENDING');
});

test('POST /payments: 503 UPSTREAM_UNAVAILABLE hides internals', async () => {
  const a = await buildServer(createPool(), async () => ({ kind: 'unavailable', reason: 'connect ECONNREFUSED 10.0.0.7:8000' }));
  a.log.level = 'silent';
  const res = await post(a, { registration_id: REG });
  const b = assertProblem(res, 503, 'UPSTREAM_UNAVAILABLE');
  assert.ok(!JSON.stringify(b).includes('10.0.0.7'));
});

test('POST /payments: 400 for missing/invalid registration_id, 401 without user', async () => {
  const a = await buildServer(createPool(), async () => { throw new Error('must not be called'); });
  a.log.level = 'silent';
  for (const payload of [{}, { registration_id: 'r1' }, { registration_id: 42 }, { registration_id: '' }]) {
    assertProblem(await post(a, payload), 400, 'VALIDATION_ERROR');
  }
  const badJson = await a.inject({ method: 'POST', url: '/payments', headers: { 'content-type': 'application/json', 'x-user-id': USER }, payload: '{nope' });
  assertProblem(badJson, 400, 'VALIDATION_ERROR');
  assertProblem(await post(a, { registration_id: REG }, {}), 401, 'UNAUTHENTICATED');
});

test('POST /payments: idempotent, an existing payment is returned unchanged with 200 (no Subscription call)', async () => {
  const a = await buildServer(createPool([row({ registration_id: REG, status: 'APPROVED' })]), async () => { throw new Error('must not be called'); });
  a.log.level = 'silent';
  const res = await post(a, { registration_id: REG });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'APPROVED');
  // another user asking for the same registration gets the usual 404
  assertProblem(await post(a, { registration_id: REG }, { 'x-user-id': OTHER }), 404, 'REGISTRATION_NOT_FOUND');
});

test('simulate: old action names are rejected with 400', async () => {
  const a = await app(fakePool([row()]));
  for (const action of ['confirm', 'refuse', 'nope']) {
    const res = await a.inject({ method: 'POST', url: `/payments/${PID}/simulate`, headers: { 'x-user-id': USER }, payload: { action } });
    assertProblem(res, 400, 'VALIDATION_ERROR');
  }
});

test('simulate: 409 PAYMENT_NOT_APPLIED keeps the real payment status', async () => {
  const a = await app(fakePool([row({ status: 'APPROVED' })]));
  const res = await a.inject({ method: 'POST', url: `/payments/${PID}/simulate`, headers: { 'x-user-id': USER }, payload: { action: 'decline' } });
  const b = assertProblem(res, 409, 'PAYMENT_NOT_APPLIED');
  assert.equal(b.payment_status, 'APPROVED');
  assert.match(b.detail, /already APPROVED/);
});

test('simulate: approve on an already approved payment is a no-op 200', async () => {
  const a = await app(fakePool([row({ status: 'APPROVED' })]));
  const res = await a.inject({ method: 'POST', url: `/payments/${PID}/simulate`, headers: { 'x-user-id': USER }, payload: { action: 'approve' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'APPROVED');
});

test('simulate: 401 without a valid user', async () => {
  const res = await (await app(fakePool([row()]))).inject({ method: 'POST', url: `/payments/${PID}/simulate`, payload: { action: 'approve' } });
  assertProblem(res, 401, 'UNAUTHENTICATED');
});

test('500 INTERNAL_ERROR never leaks internals', async () => {
  const boom = {
    query: async () => { throw new Error('secret db password leaked'); },
    connect: async () => { throw new Error('secret db password leaked'); },
  } as unknown as Pool;
  const res = await (await app(boom)).inject({ method: 'GET', url: '/payments/' + PID, headers: { 'x-user-id': USER } });
  const b = assertProblem(res, 500, 'INTERNAL_ERROR');
  assert.ok(!JSON.stringify(b).includes('secret'));
  assert.equal(b.detail, undefined);
});
