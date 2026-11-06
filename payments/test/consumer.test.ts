import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { handleSubscriptionMessage } from '../src/consumer.ts';

type Row = { payment_id: string; registration_id: string; user_id: string; event_id: string | null; activity_id: string | null; amount_minor: string; currency: string; status: string; expires_at: Date; created_at: Date };

const payment = (status: string): Row => ({
  payment_id: 'p1', registration_id: 'r1', user_id: 'u1', event_id: 'e1', activity_id: 'a1', amount_minor: '2500', currency: 'BRL', status,
  expires_at: new Date('2030-01-01T00:00:00Z'), created_at: new Date('2026-01-01T00:00:00Z'),
});

// In-memory fake of the tables the consumer touches.
function fakeDb(rows: Row[]) {
  const processed = new Set<string>();
  const transitions: unknown[][] = [];
  const outbox: { topic: string; value: any }[] = [];
  const state = { failOn: '' };
  const query = async (sql: string, params: any[] = []) => {
    if (state.failOn && sql.includes(state.failOn)) throw new Error('db down');
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
    if (/INSERT INTO processed_messages/.test(sql)) {
      if (processed.has(params[0])) return { rows: [], rowCount: 0 };
      processed.add(params[0]);
      return { rows: [], rowCount: 1 };
    }
    if (/FROM payments WHERE registration_id/.test(sql)) {
      const r = rows.filter((x) => x.registration_id === params[0]);
      return { rows: r, rowCount: r.length };
    }
    if (/^\s*UPDATE payments/.test(sql)) {
      const r = rows.find((x) => x.payment_id === params[0])!;
      r.status = params[1];
      return { rows: [r], rowCount: 1 };
    }
    if (/INSERT INTO payment_transitions/.test(sql)) { transitions.push(params); return { rows: [], rowCount: 1 }; }
    if (/INSERT INTO outbox/.test(sql)) {
      outbox.push({ topic: params[0], value: JSON.parse(params[2]) });
      return { rows: [], rowCount: 1 };
    }
    throw new Error('unexpected sql: ' + sql);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) } as unknown as Pool;
  return { pool, rows, transitions, outbox, processed, state };
}

const logs: { level: string; o: any; m: string }[] = [];
const log = { info: (o: object, m: string) => logs.push({ level: 'info', o, m }), warn: (o: object, m: string) => logs.push({ level: 'warn', o, m }) };

const msg = (over: object = {}) => JSON.stringify({
  message_id: 'ev1', schema_version: 1, type: 'RegistrationCancelled', registration_id: 'r1', user_id: 'u1',
  aggregate_version: 2, occurred_at: '2026-10-31T12:00:00Z', status: 'CANCELLED', trace_id: 'req-1', ...over,
});

test('cancel for a PENDING payment cancels it (no notification), reason registration_cancelled', async () => {
  const db = fakeDb([payment('PENDING')]);
  assert.equal(await handleSubscriptionMessage(db.pool, msg(), {}, log), 'applied');
  assert.equal(db.rows[0].status, 'CANCELLED');
  assert.deepEqual(db.transitions[0], ['p1', 'PENDING', 'CANCELLED', 'registration_cancelled', 'req-1']);
  assert.deepEqual(db.outbox.map((o) => o.value.type), ['PaymentCancelled']);
});

test('expire for a PENDING payment cancels it with reason registration_expired', async () => {
  const db = fakeDb([payment('PENDING')]);
  await handleSubscriptionMessage(db.pool, msg({ type: 'RegistrationExpired' }), {}, log);
  assert.equal(db.rows[0].status, 'CANCELLED');
  assert.equal(db.transitions[0][3], 'registration_expired');
});

test('cancel and expire for an APPROVED payment refund it and notify', async () => {
  for (const [type, reason] of [['RegistrationCancelled', 'registration_cancelled'], ['RegistrationExpired', 'registration_expired']]) {
    const db = fakeDb([payment('APPROVED')]);
    assert.equal(await handleSubscriptionMessage(db.pool, msg({ type }), {}, log), 'applied');
    assert.equal(db.rows[0].status, 'REFUNDED');
    assert.deepEqual(db.transitions[0], ['p1', 'APPROVED', 'REFUNDED', reason, 'req-1']);
    assert.deepEqual(db.outbox.map((o) => [o.topic, o.value.type ?? 'notice']), [['payments.events', 'PaymentRefunded'], ['notifications', 'notice']]);
    assert.equal(db.outbox[0].value.reason, reason);
  }
});

test('no payment, or a payment already in a final state: no-op', async () => {
  const none = fakeDb([]);
  assert.equal(await handleSubscriptionMessage(none.pool, msg(), {}, log), 'no_payment');
  for (const status of ['DECLINED', 'EXPIRED', 'CANCELLED', 'REFUNDED']) {
    const db = fakeDb([payment(status)]);
    assert.equal(await handleSubscriptionMessage(db.pool, msg(), {}, log), 'noop');
    assert.equal(db.rows[0].status, status);
    assert.equal(db.outbox.length, 0);
    assert.equal(db.transitions.length, 0);
  }
});

test('duplicate message_id is applied once', async () => {
  const db = fakeDb([payment('APPROVED')]);
  assert.equal(await handleSubscriptionMessage(db.pool, msg(), {}, log), 'applied');
  assert.equal(await handleSubscriptionMessage(db.pool, msg(), {}, log), 'duplicate');
  assert.equal(db.outbox.filter((o) => o.topic === 'payments.events').length, 1);
});

test('invalid and unknown messages are skipped without touching the database; logs carry no payload', async () => {
  const db = fakeDb([payment('PENDING')]);
  logs.length = 0;
  const secret = 'SECRET-PAYLOAD';
  for (const raw of [undefined, '', '{nope', JSON.stringify({ type: 'RegistrationCancelled', note: secret }), msg({ schema_version: 2, note: secret })]) {
    assert.equal(await handleSubscriptionMessage(db.pool, raw, { offset: '7' }, log), 'invalid');
  }
  for (const type of ['RegistrationPendingPayment', 'RegistrationConfirmed', 'Whatever']) {
    assert.equal(await handleSubscriptionMessage(db.pool, msg({ type }), {}, log), 'ignored');
  }
  assert.equal(db.rows[0].status, 'PENDING');
  assert.equal(db.processed.size, 0);
  assert.ok(logs.length >= 5 && !JSON.stringify(logs).includes(secret));
});

test('a database error throws so the offset is not committed', async () => {
  const db = fakeDb([payment('PENDING')]);
  db.state.failOn = 'processed_messages';
  await assert.rejects(handleSubscriptionMessage(db.pool, msg(), {}, log), /db down/);
});
