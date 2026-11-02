import test from 'node:test';
import assert from 'node:assert/strict';
import { buildNotification, buildPaymentEvent, eventTypeFor, type PaymentView } from '../src/events.ts';

const p = (status: string): PaymentView => ({
  payment_id: 'p1', registration_id: 'r1', user_id: 'u1', event_id: 'e1', activity_id: 'a1',
  amount: 50, currency: 'BRL', status,
});

test('event types follow the contract the reports service consumes', () => {
  assert.equal(eventTypeFor('PENDING'), 'payment.created');
  assert.equal(eventTypeFor('CONFIRMED'), 'payment.confirmed');
  assert.equal(eventTypeFor('REFUSED'), 'payment.refused');
  assert.equal(eventTypeFor('EXPIRED'), 'payment.expired');
  assert.equal(eventTypeFor('CANCELLED'), 'payment.cancelled');
  assert.throws(() => eventTypeFor('WHATEVER'));
});

test('payment event has the envelope, the full ids and is keyed by registration', () => {
  const e = buildPaymentEvent(p('CONFIRMED'), 'simulated_confirmation', 'c1', 'm1', new Date('2026-10-31T12:00:00Z'));
  assert.equal(e.key, 'r1');
  assert.deepEqual(JSON.parse(e.value), {
    message_id: 'm1', type: 'payment.confirmed', version: 1, occurred_at: '2026-10-31T12:00:00.000Z', correlation_id: 'c1',
    data: {
      payment_id: 'p1', registration_id: 'r1', user_id: 'u1', event_id: 'e1', activity_id: 'a1',
      amount: 50, currency: 'BRL', status: 'CONFIRMED', reason: 'simulated_confirmation',
    },
  });
});

test('notifications: payload and payload_type go together, keyed by user', () => {
  const n = buildNotification(p('CONFIRMED'));
  assert.ok(n);
  assert.equal(n.key, 'u1');
  const body = JSON.parse(n.value);
  assert.equal(body.user_id, 'u1');
  assert.match(body.message, /confirmado/);
  assert.equal(body.payload_type, 'payment');
  assert.deepEqual(body.payload, { payment_id: 'p1', registration_id: 'r1', status: 'CONFIRMED' });
  assert.ok(buildNotification(p('REFUSED')));
  assert.ok(buildNotification(p('EXPIRED')));
});

test('no notification for a new or user-cancelled payment', () => {
  assert.equal(buildNotification(p('PENDING')), null);
  assert.equal(buildNotification(p('CANCELLED')), null);
});
