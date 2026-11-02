import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, isFinal } from '../src/state.ts';

const future = new Date('2026-10-31T13:00:00Z');
const past = new Date('2026-10-31T11:00:00Z');
const now = new Date('2026-10-31T12:00:00Z');

test('PENDING can go to every final state', () => {
  for (const to of ['CONFIRMED', 'REFUSED', 'EXPIRED', 'CANCELLED'] as const) {
    assert.deepEqual(decide('PENDING', to, 'r', future, now), { kind: 'apply', to, reason: 'r', granted: true });
  }
});

test('final states never change; repeating the same request is a no-op', () => {
  assert.deepEqual(decide('CONFIRMED', 'CONFIRMED', 'r', future, now), { kind: 'noop' });
  assert.equal(decide('CONFIRMED', 'CANCELLED', 'r', future, now).kind, 'reject');
  assert.equal(decide('REFUSED', 'CONFIRMED', 'r', future, now).kind, 'reject');
  assert.equal(decide('EXPIRED', 'CONFIRMED', 'r', future, now).kind, 'reject');
  assert.ok(isFinal('EXPIRED') && !isFinal('PENDING'));
});

test('a confirmation after the deadline expires the payment instead (RN03)', () => {
  assert.deepEqual(decide('PENDING', 'CONFIRMED', 'r', past, now), {
    kind: 'apply', to: 'EXPIRED', reason: 'expired_before_confirmation', granted: false,
  });
  // exactly at the deadline counts as expired
  assert.equal((decide('PENDING', 'CONFIRMED', 'r', now, now) as { to: string }).to, 'EXPIRED');
});

test('refusing or cancelling after the deadline still works as asked', () => {
  assert.deepEqual(decide('PENDING', 'REFUSED', 'r', past, now), { kind: 'apply', to: 'REFUSED', reason: 'r', granted: true });
  assert.deepEqual(decide('PENDING', 'EXPIRED', 'r', past, now), { kind: 'apply', to: 'EXPIRED', reason: 'r', granted: true });
});
