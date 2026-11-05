import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotification, buildPaymentEvent, eventTypeFor, formatAmount, type PaymentView } from '../src/events.ts';

const p = (status: string): PaymentView => ({
  payment_id: 'p1', registration_id: 'r1', user_id: 'u1', event_id: 'e1', activity_id: 'a1',
  amount_minor: 2500, currency: 'BRL', status,
});

test('event types follow Subscription naming', () => {
  assert.equal(eventTypeFor('PENDING'), 'PaymentCreated');
  assert.equal(eventTypeFor('APPROVED'), 'PaymentApproved');
  assert.equal(eventTypeFor('DECLINED'), 'PaymentDeclined');
  assert.equal(eventTypeFor('EXPIRED'), 'PaymentExpired');
  assert.equal(eventTypeFor('CANCELLED'), 'PaymentCancelled');
  assert.throws(() => eventTypeFor('WHATEVER'));
});

test('payment event is a flat envelope keyed by registration', () => {
  const e = buildPaymentEvent(p('APPROVED'), 'simulated_approval', 'c1', 'm1', new Date('2026-10-31T12:00:00Z'));
  assert.equal(e.key, 'r1');
  const body = JSON.parse(e.value);
  assert.deepEqual(body, {
    message_id: 'm1', schema_version: 1, type: 'PaymentApproved', occurred_at: '2026-10-31T12:00:00.000Z', trace_id: 'c1',
    payment_id: 'p1', registration_id: 'r1', user_id: 'u1', event_id: 'e1', activity_id: 'a1',
    amount_minor: 2500, currency: 'BRL', status: 'APPROVED', reason: 'simulated_approval',
  });
  assert.equal('data' in body, false);
  assert.equal(body.message_id, 'm1'); // message id, not the Events-service event
  assert.equal(body.event_id, 'e1');
  assert.equal(body.activity_id, 'a1');
  assert.ok(!('parent_event_id' in body));
});

test('notifications: payload and payload_type go together, keyed by user', () => {
  const n = buildNotification(p('APPROVED'));
  assert.ok(n);
  assert.equal(n.key, 'u1');
  const body = JSON.parse(n.value);
  assert.equal(body.user_id, 'u1');
  assert.match(body.message, /confirmado/);
  assert.equal(body.payload_type, 'payment');
  assert.deepEqual(body.payload, { payment_id: 'p1', registration_id: 'r1', status: 'APPROVED' });
  assert.ok(buildNotification(p('DECLINED')));
  assert.ok(buildNotification(p('EXPIRED')));
});

test('no notification for a new or user-cancelled payment', () => {
  assert.equal(buildNotification(p('PENDING')), null);
  assert.equal(buildNotification(p('CANCELLED')), null);
});

test('notification shows a human amount computed from amount_minor', () => {
  const body = JSON.parse(buildNotification(p('APPROVED'))!.value);
  assert.match(body.message, /BRL 25\.00/);
  assert.equal(formatAmount(2500, 'BRL'), 'BRL 25.00');
  assert.equal(formatAmount(5, 'BRL'), 'BRL 0.05');
  assert.equal(formatAmount(123456, 'USD'), 'USD 1234.56');
});

test('REFUNDED maps to PaymentRefunded and notifies the user in Portuguese', () => {
  assert.equal(eventTypeFor('REFUNDED'), 'PaymentRefunded');
  const e = JSON.parse(buildPaymentEvent(p('REFUNDED'), 'registration_cancelled', null, 'm2', new Date('2026-10-31T12:00:00Z')).value);
  assert.equal(e.type, 'PaymentRefunded');
  assert.equal(e.status, 'REFUNDED');
  assert.equal(e.reason, 'registration_cancelled');
  assert.equal(e.trace_id, null);
  const n = JSON.parse(buildNotification(p('REFUNDED'))!.value);
  assert.match(n.message, /reembolsado/);
  assert.match(n.message, /BRL 25\.00/);
  assert.equal(n.payload.status, 'REFUNDED');
});

test('a payment without an event publishes event_id null', () => {
  const e = JSON.parse(buildPaymentEvent({ ...p('PENDING'), event_id: null }, null, null, 'm3', new Date()).value);
  assert.equal(e.event_id, null);
});

test('old CONFIRMED / REFUSED statuses are no longer mapped', () => {
  assert.throws(() => eventTypeFor('CONFIRMED'));
  assert.throws(() => eventTypeFor('REFUSED'));
  assert.match(JSON.parse(buildNotification(p('DECLINED'))!.value).message, /recusado/);
  assert.equal(buildNotification(p('CONFIRMED')), null);
});
