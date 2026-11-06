import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildServer } from '../src/server.ts';

// A fake pool that answers by the SQL it receives with canned rows, shaped like pg returns them:
// bigint and sum() columns come back as strings.
const USER = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';
const OWNER = { 'x-user-id': USER };
const eventRow = { event_id: EVENT, organizer_id: USER, name: 'Conf', status: 'PUBLISHED', starts_at: null, ends_at: null };

type Call = { sql: string; params?: unknown[] };

function poolWith(
  rows: { payments?: object; money?: object[]; activities?: object[]; registrations?: object; total?: number; lifecycle?: object; attendance?: object },
  calls: Call[] = [],
): Pool {
  const query = async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes('count(*)::int AS total')) return { rows: [{ total: rows.total ?? 0 }] };
    if (sql.includes("lifecycle = 'OPEN'")) return { rows: [rows.lifecycle ?? { open: 0, ended: 0, cancelled: 0 }] };
    if (sql.includes('FROM events WHERE organizer_id')) return { rows: [eventRow] };
    if (sql.includes('FROM events WHERE event_id')) return { rows: [eventRow] };
    if (sql.includes('FROM payments') && sql.includes('sum(amount_minor)')) return { rows: rows.money ?? [] };
    if (sql.includes('AS occupied')) return { rows: [{ capacity: 10, occupied: 4 }] };
    if (/FROM activities a\s/.test(sql)) return { rows: rows.activities ?? [] };
    if (sql.includes('AS checkins') && sql.includes('AS confirmed')) return { rows: [rows.attendance ?? { confirmed: 2, checkins: 1, attendees: 1, certificate_eligible: 1 }] };
    if (sql.includes('FROM payments')) return { rows: [rows.payments] };
    if (sql.includes('FROM registrations')) return { rows: [rows.registrations] };
    throw new Error(`unexpected query: ${sql}`);
  };
  return { query } as unknown as Pool;
}

const paymentCounts = { pending: 1, approved: 2, declined: 3, expired: 4, cancelled: 5, refunded_count: 1 };
const registrationCounts = { pending_payment: 1, offered: 2, confirmed: 3, waitlisted: 4, cancelled: 5, expired: 6, rejected: 7, total: 28 };

test('payments: counters and revenue/refunded as lists by currency, bigint strings become numbers', async () => {
  const pool = poolWith({
    payments: paymentCounts,
    money: [
      { activity_id: null, status: 'APPROVED', currency: 'USD', amount_minor: '1000' },
      { activity_id: null, status: 'APPROVED', currency: 'BRL', amount_minor: '2500' },
      { activity_id: null, status: 'REFUNDED', currency: 'BRL', amount_minor: '700' },
    ],
  });
  const app = await buildServer(pool);
  try {
    const res = await app.inject({ method: 'GET', url: `/events/${EVENT}/payments`, headers: OWNER });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), {
      ...paymentCounts,
      revenue: [{ currency: 'BRL', amount_minor: 2500 }, { currency: 'USD', amount_minor: 1000 }],
      refunded: [{ currency: 'BRL', amount_minor: 700 }],
    });
  } finally {
    await app.close();
  }
});

test('payments: empty lists when there is no money', async () => {
  const app = await buildServer(poolWith({ payments: { ...paymentCounts, approved: 0 } }));
  try {
    const res = await app.inject({ method: 'GET', url: `/events/${EVENT}/payments`, headers: OWNER });
    assert.deepEqual([res.json().revenue, res.json().refunded], [[], []]);
  } finally {
    await app.close();
  }
});

test('payments: an amount beyond the safe-integer range is an error, not a lossy number', async () => {
  const pool = poolWith({
    payments: paymentCounts,
    money: [{ activity_id: null, status: 'APPROVED', currency: 'BRL', amount_minor: '9007199254740993' }],
  });
  const app = await buildServer(pool);
  try {
    const res = await app.inject({ method: 'GET', url: `/events/${EVENT}/payments`, headers: OWNER });
    assert.equal(res.statusCode, 500);
  } finally {
    await app.close();
  }
});

test('registrations: the new status counters, without the old pending', async () => {
  const app = await buildServer(poolWith({ registrations: registrationCounts }));
  try {
    const res = await app.inject({ method: 'GET', url: `/events/${EVENT}/registrations`, headers: OWNER });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), registrationCounts);
    assert.equal('pending' in res.json(), false);
  } finally {
    await app.close();
  }
});

test('activities: per-activity counters, money by currency and held-seat occupancy', async () => {
  const pool = poolWith({
    activities: [{
      activity_id: 'a1', name: 'Workshop', capacity: 10, paid: true, lifecycle: 'ENDED', ended_at: new Date('2026-12-01T18:00:00.000Z'),
      pending_payment: 1, offered: 2, confirmed: 3, waitlisted: 4, cancelled: 5, expired: 6, rejected: 7,
      payments_approved: 2, checkins: 1,
    }],
    lifecycle: { open: 3, ended: 1, cancelled: 2 },
    money: [
      { activity_id: 'a1', status: 'APPROVED', currency: 'BRL', amount_minor: '5000' },
      { activity_id: 'a1', status: 'REFUNDED', currency: 'UNKNOWN', amount_minor: '300' },
      { activity_id: 'a2', status: 'APPROVED', currency: 'BRL', amount_minor: '999' },
    ],
  });
  const app = await buildServer(pool);
  try {
    const res = await app.inject({ method: 'GET', url: `/events/${EVENT}/activities`, headers: OWNER });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().activities, { open: 3, ended: 1, cancelled: 2 });
    assert.deepEqual(res.json().items, [{
      activity_id: 'a1', name: 'Workshop', capacity: 10, paid: true, lifecycle: 'ENDED', ended_at: '2026-12-01T18:00:00.000Z',
      pending_payment: 1, offered: 2, confirmed: 3, waitlisted: 4, cancelled: 5, expired: 6, rejected: 7,
      payments_approved: 2,
      revenue: [{ currency: 'BRL', amount_minor: 5000 }],
      refunded: [{ currency: 'UNKNOWN', amount_minor: 300 }],
      occupied: 6, occupancy_rate: 0.6, checkins: 1, attendance_rate: 0.3333,
    }]);
  } finally {
    await app.close();
  }
});

test('summary: carries the new registrations and payments shapes', async () => {
  const pool = poolWith({
    registrations: registrationCounts,
    payments: paymentCounts,
    money: [{ activity_id: null, status: 'APPROVED', currency: 'BRL', amount_minor: '2500' }],
    lifecycle: { open: 2, ended: 1, cancelled: 1 },
  });
  const app = await buildServer(pool);
  try {
    const res = await app.inject({ method: 'GET', url: `/events/${EVENT}/summary`, headers: OWNER });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.registrations, registrationCounts);
    assert.deepEqual(body.payments.revenue, [{ currency: 'BRL', amount_minor: 2500 }]);
    assert.deepEqual(body.payments.refunded, []);
    assert.deepEqual(body.occupancy, { capacity: 10, occupied: 4, rate: 0.4 });
    assert.deepEqual(body.attendance, { confirmed: 2, checkins: 1, rate: 0.5, certificate_eligible: 1, certificate_eligible_rate: 1 });
    assert.deepEqual(body.activities, { open: 2, ended: 1, cancelled: 1 });
  } finally {
    await app.close();
  }
});

test('attendance: certificate_eligible and its rate; null rate without attendees; rate computed from the counts', async () => {
  const app = await buildServer(poolWith({ attendance: { confirmed: 4, checkins: 3, attendees: 3, certificate_eligible: 1 } }));
  try {
    const res = await app.inject({ method: 'GET', url: `/events/${EVENT}/attendance`, headers: OWNER });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { confirmed: 4, checkins: 3, rate: 0.75, certificate_eligible: 1, certificate_eligible_rate: 0.3333 });
  } finally {
    await app.close();
  }
  const empty = await buildServer(poolWith({ attendance: { confirmed: 0, checkins: 0, attendees: 0, certificate_eligible: 0 } }));
  try {
    const res = await empty.inject({ method: 'GET', url: `/events/${EVENT}/attendance`, headers: OWNER });
    assert.deepEqual(res.json(), { confirmed: 0, checkins: 0, rate: null, certificate_eligible: 0, certificate_eligible_rate: null });
  } finally {
    await empty.close();
  }
});

const problemType = /^application\/problem\+json/;

test('identity: X-User-Id missing or not a UUID is 401 UNAUTHENTICATED (problem+json), for every route', async () => {
  const calls: Call[] = [];
  const app = await buildServer(poolWith({ registrations: registrationCounts }, calls));
  try {
    const urls = ['/events', ...['summary', 'activities', 'registrations', 'payments', 'attendance'].map((s) => `/events/${EVENT}/${s}`)];
    for (const url of urls) {
      for (const headers of [{}, { 'x-user-id': 'organizer-1' }, { 'x-user-id': '' }, { 'x-user-id': `${USER}x` }]) {
        const res = await app.inject({ method: 'GET', url, headers });
        assert.equal(res.statusCode, 401, `${url} ${JSON.stringify(headers)}`);
        assert.match(String(res.headers['content-type']), problemType);
        const { traceId, ...rest } = res.json();
        assert.deepEqual(rest, {
          title: 'Unauthorized', status: 401, code: 'UNAUTHENTICATED', detail: 'X-User-Id header is missing or not a UUID',
        });
        assert.equal(traceId, res.headers['x-trace-id']);
      }
    }
    assert.equal(calls.length, 0, 'no database access without an identity');
  } finally {
    await app.close();
  }
});

test('identity: a UUID is accepted; X-User-Roles is ignored', async () => {
  const app = await buildServer(poolWith({ registrations: registrationCounts }));
  try {
    const res = await app.inject({
      method: 'GET', url: `/events/${EVENT}/registrations`,
      headers: { 'x-user-id': USER, 'x-user-roles': 'ADMIN' },
    });
    assert.equal(res.statusCode, 200);
    const other = await app.inject({
      method: 'GET', url: `/events/${EVENT}/registrations`,
      headers: { 'x-user-id': '33333333-3333-4333-8333-333333333333', 'x-user-roles': 'ADMIN' },
    });
    assert.equal(other.statusCode, 404, 'a role never grants access to someone else\'s event');
  } finally {
    await app.close();
  }
});

test('ownership: another user\'s event and an unknown event are the same 404 EVENT_NOT_FOUND', async () => {
  const unknown = { query: async () => ({ rows: [] }) } as unknown as Pool;
  const mine = poolWith({ registrations: registrationCounts });
  const bodies: unknown[] = [];
  for (const [pool, user] of [[mine, '33333333-3333-4333-8333-333333333333'], [unknown, USER]] as const) {
    const app = await buildServer(pool);
    try {
      const res = await app.inject({ method: 'GET', url: `/events/${EVENT}/registrations`, headers: { 'x-user-id': user } });
      assert.equal(res.statusCode, 404);
      assert.match(String(res.headers['content-type']), problemType);
      const { traceId, ...rest } = res.json();
      assert.equal(traceId, res.headers['x-trace-id']);
      bodies.push(rest);
    } finally {
      await app.close();
    }
  }
  assert.deepEqual(bodies[0], bodies[1]);
  assert.deepEqual(bodies[0], { title: 'Not Found', status: 404, code: 'EVENT_NOT_FOUND', detail: 'event not found' });
});

test('a path id that is not a UUID is the same 404 EVENT_NOT_FOUND and never reaches the database', async () => {
  const calls: Call[] = [];
  const app = await buildServer(poolWith({ registrations: registrationCounts }, calls));
  try {
    for (const section of ['summary', 'activities', 'registrations', 'payments', 'attendance']) {
      const res = await app.inject({ method: 'GET', url: `/events/e1/${section}`, headers: OWNER });
      assert.equal(res.statusCode, 404, section);
      assert.equal(res.json().code, 'EVENT_NOT_FOUND', section);
    }
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test('events list: defaults, {items,total,limit,offset} and the page reaching the query', async () => {
  const calls: Call[] = [];
  const app = await buildServer(poolWith({ total: 45 }, calls));
  try {
    const res = await app.inject({ method: 'GET', url: '/events', headers: OWNER });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(Object.keys(body), ['items', 'total', 'limit', 'offset']);
    assert.deepEqual([body.total, body.limit, body.offset], [45, 20, 0]);
    assert.deepEqual(body.items, [{ event_id: EVENT, name: 'Conf', status: 'PUBLISHED', starts_at: null, ends_at: null }]);
    assert.deepEqual(calls.find((c) => c.sql.includes('LIMIT'))?.params, [USER, 20, 0]);

    const paged = await app.inject({ method: 'GET', url: '/events?limit=100&offset=40', headers: OWNER });
    assert.deepEqual([paged.json().limit, paged.json().offset], [100, 40]);
    assert.deepEqual(calls.filter((c) => c.sql.includes('LIMIT')).at(-1)?.params, [USER, 100, 40]);
  } finally {
    await app.close();
  }
});

test('activities list: {items,total,limit,offset} with the item shape unchanged', async () => {
  const calls: Call[] = [];
  const activity = {
    activity_id: 'a1', name: 'Workshop', capacity: 10, paid: true,
    pending_payment: 0, offered: 0, confirmed: 1, waitlisted: 0, cancelled: 0, expired: 0, rejected: 0,
    payments_approved: 0, checkins: 0,
  };
  const app = await buildServer(poolWith({ activities: [activity], total: 31 }, calls));
  try {
    const res = await app.inject({ method: 'GET', url: `/events/${EVENT}/activities?limit=1&offset=30`, headers: OWNER });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual([body.total, body.limit, body.offset, body.items.length], [31, 1, 30, 1]);
    assert.equal(body.items[0].activity_id, 'a1');
    assert.deepEqual(calls.find((c) => c.sql.includes('FROM activities a'))?.params, [EVENT, 1, 30]);
  } finally {
    await app.close();
  }
});

test('list parameters out of range or not integers: 400 VALIDATION_ERROR (problem+json)', async () => {
  const calls: Call[] = [];
  const app = await buildServer(poolWith({}, calls));
  try {
    for (const q of ['limit=0', 'limit=101', 'limit=abc', 'limit=1.5', 'offset=-1', 'offset=x']) {
      for (const url of [`/events?${q}`, `/events/${EVENT}/activities?${q}`]) {
        const res = await app.inject({ method: 'GET', url, headers: OWNER });
        assert.equal(res.statusCode, 400, url);
        assert.match(String(res.headers['content-type']), problemType);
        const body = res.json();
        assert.deepEqual([body.title, body.status, body.code], ['Bad Request', 400, 'VALIDATION_ERROR'], url);
        assert.ok(body.detail && body.traceId, url);
      }
    }
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});
