import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSubscriptionMessage, validateCreate } from '../src/contracts.ts';

const REG = '44444444-4444-4444-8444-444444444444';

test('create body: only registration_id (UUID) is read; unknown properties are ignored', () => {
  const v = validateCreate({ registration_id: REG, user_id: 'x', amount_minor: 1 });
  assert.ok(v.ok);
  assert.deepEqual(v.value, { registrationId: REG });
});

test('create body: missing, non-string or non-UUID registration_id is rejected', () => {
  for (const b of [null, [], 'x', {}, { registration_id: 5 }, { registration_id: 'r1' }, { registration_id: '' }]) {
    assert.ok(!validateCreate(b).ok);
  }
});

const msg = (over: object = {}) => JSON.stringify({
  message_id: 'ev1', schema_version: 1, type: 'RegistrationCancelled', registration_id: 'r1', activity_id: 'a', user_id: 'u',
  aggregate_version: 3, occurred_at: '2026-10-31T12:00:00Z', status: 'CANCELLED', trace_id: 'req-1', extra: { x: 1 }, ...over,
});

test('subscription message: cancel and expire map to a close reason; extra fields are tolerated', () => {
  const c = parseSubscriptionMessage(msg());
  assert.ok(c.ok);
  assert.deepEqual(c.value, { messageId: 'ev1', type: 'RegistrationCancelled', registrationId: 'r1', traceId: 'req-1', closeReason: 'registration_cancelled' });
  const e = parseSubscriptionMessage(msg({ type: 'RegistrationExpired', trace_id: null }));
  assert.ok(e.ok && e.value.closeReason === 'registration_expired' && e.value.traceId === null);
});

test('subscription message: a message that only has the old request_id has no trace id', () => {
  const r = parseSubscriptionMessage(msg({ trace_id: undefined, request_id: 'req-1' }));
  assert.ok(r.ok && r.value.traceId === null);
});

test('subscription message: other types parse but have no close reason', () => {
  for (const type of ['RegistrationPendingPayment', 'RegistrationConfirmed', 'SomethingNew']) {
    const v = parseSubscriptionMessage(msg({ type }));
    assert.ok(v.ok && v.value.closeReason === null);
  }
});

test('subscription message: invalid ones are rejected', () => {
  assert.ok(!parseSubscriptionMessage('{nope').ok);
  assert.ok(!parseSubscriptionMessage('[]').ok);
  assert.ok(!parseSubscriptionMessage('null').ok);
  for (const k of ['message_id', 'type', 'registration_id', 'schema_version']) {
    assert.ok(!parseSubscriptionMessage(msg({ [k]: undefined })).ok, `${k} required`);
  }
  assert.ok(!parseSubscriptionMessage(msg({ message_id: '  ' })).ok);
  // the old name for the message id is no longer accepted
  const old = parseSubscriptionMessage(msg({ message_id: undefined, event_id: 'ev1' }));
  assert.ok(!old.ok && old.error === 'message_id is required');
  assert.ok(!parseSubscriptionMessage(msg({ schema_version: 2 })).ok);
  assert.ok(!parseSubscriptionMessage(msg({ schema_version: 1.5 })).ok);
  assert.ok(!parseSubscriptionMessage(msg({ schema_version: '1' })).ok);
});
