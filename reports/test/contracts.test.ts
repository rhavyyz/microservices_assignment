import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../src/contracts.ts';

const env = (type: string, data: object, extra: object = {}) =>
  JSON.stringify({ message_id: 'm1', type, version: 1, occurred_at: '2026-10-31T12:00:00Z', trace_id: 't1', data, ...extra });

test('registration.confirmed maps to CONFIRMED', () => {
  const r = parseMessage(env('registration.confirmed', { registration_id: 'r1', event_id: 'e1', activity_id: 'a1', user_id: 'u1' }));
  assert.ok(r.ok);
  assert.deepEqual(r.value.change, { kind: 'registration', registrationId: 'r1', eventId: 'e1', activityId: 'a1', userId: 'u1', status: 'CONFIRMED' });
  assert.equal(r.value.envelope.trace_id, 't1');
});

test('payment events map to their status', () => {
  const r = parseMessage(env('payment.refused', { payment_id: 'p1', event_id: 'e1', amount: 50, currency: 'BRL' }));
  assert.ok(r.ok && r.value.change.kind === 'payment');
  assert.equal(r.value.change.status, 'REFUSED');
  assert.equal(r.value.change.amount, 50);
});

test('event.cancelled forces the CANCELLED status', () => {
  const r = parseMessage(env('event.cancelled', { event_id: 'e1', status: 'PUBLISHED' }));
  assert.ok(r.ok && r.value.change.kind === 'event');
  assert.equal(r.value.change.status, 'CANCELLED');
});

test('event.created takes organizer and status from data', () => {
  const r = parseMessage(env('event.created', { event_id: 'e1', organizer_id: 'o1', name: 'Conf', status: 'DRAFT' }));
  assert.ok(r.ok && r.value.change.kind === 'event');
  assert.equal(r.value.change.organizerId, 'o1');
  assert.equal(r.value.change.status, 'DRAFT');
});

test('unknown types are ignored, not errors', () => {
  const r = parseMessage(env('certificate.issued', { anything: 1 }));
  assert.ok(r.ok);
  assert.equal(r.value.change.kind, 'ignored');
});

test('invalid messages are rejected with a reason', () => {
  assert.deepEqual(parseMessage('not json'), { ok: false, error: 'invalid JSON' });
  assert.ok(!parseMessage(JSON.stringify({ type: 'x', occurred_at: '2026-01-01T00:00:00Z', data: {} })).ok);
  assert.ok(!parseMessage(env('payment.confirmed', { payment_id: 'p1' })).ok); // no event_id
  assert.ok(!parseMessage(env('payment.confirmed', { payment_id: 'p1', event_id: 'e1', amount: 'x' })).ok);
  assert.ok(!parseMessage(env('event.created', { event_id: 'e1' }, { occurred_at: 'nope' })).ok);
});

test('unsupported versions are rejected', () => {
  const r = parseMessage(env('event.created', { event_id: 'e1' }, { version: 2 }));
  assert.ok(!r.ok && /unsupported version/.test(r.error));
});

test('a message with only the legacy correlation_id has no trace id', () => {
  const raw = JSON.stringify({ message_id: 'm1', type: 'registration.confirmed', version: 1, occurred_at: '2026-10-31T12:00:00Z', correlation_id: 'c1', data: { registration_id: 'r1', event_id: 'e1', activity_id: 'a1', user_id: 'u1' } });
  const r = parseMessage(raw);
  assert.ok(r.ok);
  assert.equal(r.value.envelope.trace_id, null);
});
