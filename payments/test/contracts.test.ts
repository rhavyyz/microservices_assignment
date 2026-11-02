import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscriptionMessage, validateCreate } from '../src/contracts.ts';

const now = new Date('2026-10-31T12:00:00Z');
const good = {
  registration_id: 'r1', user_id: 'u1', event_id: 'e1', activity_id: 'a1',
  amount: 50, currency: 'brl', expires_at: '2026-10-31T12:15:00Z',
};

test('valid create request is normalized', () => {
  const v = validateCreate(good, now);
  assert.ok(v.ok);
  assert.equal(v.value.currency, 'BRL');
  assert.equal(v.value.amount, 50);
  assert.equal(v.value.expiresAt.toISOString(), '2026-10-31T12:15:00.000Z');
});

test('currency defaults to BRL', () => {
  const { currency: _c, ...rest } = good;
  const v = validateCreate(rest, now);
  assert.ok(v.ok && v.value.currency === 'BRL');
});

test('invalid create requests are rejected with a reason', () => {
  assert.ok(!validateCreate(null, now).ok);
  assert.ok(!validateCreate({ ...good, amount: 0 }, now).ok);
  assert.ok(!validateCreate({ ...good, amount: -5 }, now).ok);
  assert.ok(!validateCreate({ ...good, amount: '50' }, now).ok);
  assert.ok(!validateCreate({ ...good, amount: 10.123 }, now).ok);
  assert.ok(validateCreate({ ...good, amount: 10.12 }, now).ok);
  assert.ok(!validateCreate({ ...good, currency: 'REAL' }, now).ok);
  assert.ok(!validateCreate({ ...good, expires_at: '2026-10-31T11:00:00Z' }, now).ok); // past
  assert.ok(!validateCreate({ ...good, expires_at: 'tomorrow' }, now).ok);
  assert.ok(!validateCreate({ ...good, registration_id: '  ' }, now).ok);
  assert.ok(!validateCreate({ ...good, user_id: undefined }, now).ok);
});

const msg = (type: string, data: object, extra: object = {}) =>
  JSON.stringify({ message_id: 'm1', type, version: 1, occurred_at: '2026-10-31T12:00:00Z', correlation_id: 'c1', data, ...extra });

test('registration.cancelled and registration.expired cancel the payment', () => {
  const a = parseSubscriptionMessage(msg('registration.cancelled', { registration_id: 'r1' }));
  assert.ok(a.ok);
  assert.deepEqual(a.value.cancel, { registrationId: 'r1', reason: 'registration_cancelled' });
  assert.equal(a.value.correlationId, 'c1');
  const b = parseSubscriptionMessage(msg('registration.expired', { registration_id: 'r1' }));
  assert.ok(b.ok && b.value.cancel?.reason === 'registration_expired');
});

test('other subscription messages are ignored, not errors', () => {
  const r = parseSubscriptionMessage(msg('registration.confirmed', { registration_id: 'r1' }));
  assert.ok(r.ok);
  assert.equal(r.value.cancel, null);
});

test('invalid subscription messages are rejected', () => {
  assert.ok(!parseSubscriptionMessage('nope').ok);
  assert.ok(!parseSubscriptionMessage(JSON.stringify({ type: 'registration.cancelled', data: {} })).ok); // no message_id
  assert.ok(!parseSubscriptionMessage(msg('registration.cancelled', {})).ok); // no registration_id
  assert.ok(!parseSubscriptionMessage(msg('registration.cancelled', { registration_id: 'r1' }, { version: 2 })).ok);
});
