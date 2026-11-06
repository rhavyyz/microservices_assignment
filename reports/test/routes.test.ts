import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildServer } from '../src/server.ts';

// A fake pool that answers by the SQL it receives with canned rows, shaped like pg returns them:
// bigint and sum() columns come back as strings.
const OWNER = { 'x-user-id': 'organizer-1' };
const eventRow = { event_id: 'e1', organizer_id: 'organizer-1', name: 'Conf', status: 'PUBLISHED', starts_at: null, ends_at: null };

function poolWith(rows: { payments?: object; money?: object[]; activities?: object[]; registrations?: object }): Pool {
  const query = async (sql: string) => {
    if (sql.includes('FROM events WHERE event_id')) return { rows: [eventRow] };
    if (sql.includes('FROM payments') && sql.includes('sum(amount_minor)')) return { rows: rows.money ?? [] };
    if (sql.includes('FROM activities a')) return { rows: rows.activities ?? [] };
    if (sql.includes('AS occupied')) return { rows: [{ capacity: 10, occupied: 4 }] };
    if (sql.includes('AS checkins') && sql.includes('AS confirmed')) return { rows: [{ confirmed: 2, checkins: 1 }] };
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
    const res = await app.inject({ method: 'GET', url: '/events/e1/payments', headers: OWNER });
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
    const res = await app.inject({ method: 'GET', url: '/events/e1/payments', headers: OWNER });
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
    const res = await app.inject({ method: 'GET', url: '/events/e1/payments', headers: OWNER });
    assert.equal(res.statusCode, 500);
  } finally {
    await app.close();
  }
});

test('registrations: the new status counters, without the old pending', async () => {
  const app = await buildServer(poolWith({ registrations: registrationCounts }));
  try {
    const res = await app.inject({ method: 'GET', url: '/events/e1/registrations', headers: OWNER });
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
      activity_id: 'a1', name: 'Workshop', capacity: 10, paid: true,
      pending_payment: 1, offered: 2, confirmed: 3, waitlisted: 4, cancelled: 5, expired: 6, rejected: 7,
      payments_approved: 2, checkins: 1,
    }],
    money: [
      { activity_id: 'a1', status: 'APPROVED', currency: 'BRL', amount_minor: '5000' },
      { activity_id: 'a1', status: 'REFUNDED', currency: 'UNKNOWN', amount_minor: '300' },
      { activity_id: 'a2', status: 'APPROVED', currency: 'BRL', amount_minor: '999' },
    ],
  });
  const app = await buildServer(pool);
  try {
    const res = await app.inject({ method: 'GET', url: '/events/e1/activities', headers: OWNER });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json().items, [{
      activity_id: 'a1', name: 'Workshop', capacity: 10, paid: true,
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
  });
  const app = await buildServer(pool);
  try {
    const res = await app.inject({ method: 'GET', url: '/events/e1/summary', headers: OWNER });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.registrations, registrationCounts);
    assert.deepEqual(body.payments.revenue, [{ currency: 'BRL', amount_minor: 2500 }]);
    assert.deepEqual(body.payments.refunded, []);
    assert.deepEqual(body.occupancy, { capacity: 10, occupied: 4, rate: 0.4 });
    assert.deepEqual(body.attendance, { confirmed: 2, checkins: 1, rate: 0.5 });
  } finally {
    await app.close();
  }
});

test('ownership is unchanged: another user gets 404, no identity gets 401', async () => {
  const app = await buildServer(poolWith({ registrations: registrationCounts }));
  try {
    const other = await app.inject({ method: 'GET', url: '/events/e1/registrations', headers: { 'x-user-id': 'someone-else' } });
    assert.equal(other.statusCode, 404);
    const anon = await app.inject({ method: 'GET', url: '/events/e1/registrations' });
    assert.equal(anon.statusCode, 401);
  } finally {
    await app.close();
  }
});
