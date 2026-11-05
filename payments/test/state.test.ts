import test from 'node:test';
import assert from 'node:assert/strict';
import { decide, isFinal } from '../src/state.ts';

const future = new Date('2026-10-31T13:00:00Z');
const past = new Date('2026-10-31T11:00:00Z');
const now = new Date('2026-10-31T12:00:00Z');

test('PENDING can go to every final state', () => {
  for (const to of ['APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED'] as const) {
    assert.deepEqual(decide('PENDING', to, 'r', future, now), { kind: 'apply', to, reason: 'r', granted: true });
  }
});

test('final states never change; repeating the same request is a no-op', () => {
  assert.deepEqual(decide('APPROVED', 'APPROVED', 'r', future, now), { kind: 'noop' });
  assert.equal(decide('APPROVED', 'CANCELLED', 'r', future, now).kind, 'reject');
  assert.equal(decide('DECLINED', 'APPROVED', 'r', future, now).kind, 'reject');
  assert.equal(decide('EXPIRED', 'APPROVED', 'r', future, now).kind, 'reject');
  assert.ok(isFinal('EXPIRED') && !isFinal('PENDING'));
});

test('a confirmation after the deadline expires the payment instead (RN03)', () => {
  assert.deepEqual(decide('PENDING', 'APPROVED', 'r', past, now), {
    kind: 'apply', to: 'EXPIRED', reason: 'expired_before_confirmation', granted: false,
  });
  // exactly at the deadline counts as expired
  assert.equal((decide('PENDING', 'APPROVED', 'r', now, now) as { to: string }).to, 'EXPIRED');
});

test('REFUNDED: only APPROVED can be refunded, and REFUNDED is final', () => {
  assert.deepEqual(decide('APPROVED', 'REFUNDED', 'registration_cancelled', future, now), {
    kind: 'apply', to: 'REFUNDED', reason: 'registration_cancelled', granted: true,
  });
  // still applies after the payment deadline: the money was already taken
  assert.equal(decide('APPROVED', 'REFUNDED', 'r', past, now).kind, 'apply');
  for (const from of ['PENDING', 'DECLINED', 'EXPIRED', 'CANCELLED'] as const) {
    assert.equal(decide(from, 'REFUNDED', 'r', future, now).kind, 'reject', `${from} cannot be refunded`);
  }
  assert.deepEqual(decide('REFUNDED', 'REFUNDED', 'r', future, now), { kind: 'noop' });
  for (const to of ['PENDING', 'APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED'] as const) {
    assert.equal(decide('REFUNDED', to, 'r', future, now).kind, 'reject', `REFUNDED -> ${to}`);
  }
  assert.ok(isFinal('REFUNDED') && !isFinal('APPROVED'));
});

test('an approved payment cannot be cancelled, declined or expired', () => {
  for (const to of ['DECLINED', 'EXPIRED', 'CANCELLED'] as const) {
    assert.equal(decide('APPROVED', to, 'r', future, now).kind, 'reject');
  }
});

test('refusing or cancelling after the deadline still works as asked', () => {
  assert.deepEqual(decide('PENDING', 'DECLINED', 'r', past, now), { kind: 'apply', to: 'DECLINED', reason: 'r', granted: true });
  assert.deepEqual(decide('PENDING', 'EXPIRED', 'r', past, now), { kind: 'apply', to: 'EXPIRED', reason: 'r', granted: true });
});
