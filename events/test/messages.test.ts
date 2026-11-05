import test from 'node:test';
import assert from 'node:assert/strict';
import type { ActivityRow, EventRow } from '../src/domain/model.ts';
import { parseCommand } from '../src/messaging/commands.ts';
import { envelope } from '../src/messaging/envelope.ts';
import { activityMessage, eventMessage, seatRejected, seatReleased, seatReserved } from '../src/messaging/messages.ts';

const d = (s: string) => new Date(s);
const ev: EventRow = {
  id: 'e1', organizer_id: 'org', organization: 'UECE', title: 'Conf', description: 'x', location: null, banner_url: null,
  starts_at: d('2030-05-01T08:00:00Z'), ends_at: d('2030-05-03T18:00:00Z'), status: 'PUBLISHED',
  created_at: d('2026-01-01T00:00:00Z'), updated_at: d('2026-01-01T00:00:00Z'),
};
const act: ActivityRow = {
  id: 'a1', event_id: 'e1', title: 'Talk', description: null, speaker: 'Ana', location: 'Room 1',
  starts_at: d('2030-05-01T09:00:00Z'), ends_at: d('2030-05-01T10:00:00Z'), capacity: 30, reserved: 4, available: 26,
  price_cents: 5000, paid: true, waitlist_enabled: true, created_at: d('2026-01-01T00:00:00Z'),
  updated_at: d('2026-01-01T00:00:00Z'),
};
const ref = { registration_id: 'r1', event_id: 'e1', activity_id: 'a1', user_id: 'u1' };

test('envelope has the shared contract fields', () => {
  const e = envelope('event.created', { a: 1 }, 'trace', d('2030-01-01T00:00:00Z'));
  assert.match(e.message_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...e, message_id: 'x' }, {
    message_id: 'x', type: 'event.created', version: 1, occurred_at: '2030-01-01T00:00:00.000Z', trace_id: 'trace', data: { a: 1 },
  });
  assert.notEqual(envelope('t', {}, null).message_id, envelope('t', {}, null).message_id);
});

test('event messages carry what the reports service reads (name, organizer_id, status, period)', () => {
  const m = eventMessage('event.published', ev);
  assert.equal(m.key, 'e1');
  assert.deepEqual(m.data, {
    event_id: 'e1', organizer_id: 'org', organization: 'UECE', name: 'Conf', status: 'PUBLISHED',
    starts_at: '2030-05-01T08:00:00.000Z', ends_at: '2030-05-03T18:00:00.000Z',
  });
});

test('activity messages are keyed by event and carry capacity and price', () => {
  const m = activityMessage('activity.created', act);
  assert.equal(m.key, 'e1');
  assert.deepEqual(m.data, {
    activity_id: 'a1', event_id: 'e1', name: 'Talk', starts_at: '2030-05-01T09:00:00.000Z',
    ends_at: '2030-05-01T10:00:00.000Z', capacity: 30, available: 26, price_cents: 5000, currency: 'BRL',
    paid: true, waitlist_enabled: true,
  });
});

test('seat answers are keyed by registration and say what the subscription service needs next', () => {
  const reserved = seatReserved(ref, act);
  assert.equal(reserved.key, 'r1');
  assert.deepEqual(reserved.data, { ...ref, price_cents: 5000, currency: 'BRL', paid: true, available: 26 });
  assert.deepEqual(seatRejected(ref, 'FULL', act).data, { ...ref, reason: 'FULL', waitlist_enabled: true });
  assert.deepEqual(seatRejected(ref, 'ACTIVITY_NOT_FOUND', null).data, { ...ref, reason: 'ACTIVITY_NOT_FOUND', waitlist_enabled: false });
  assert.deepEqual(seatReleased(ref, act).data, { ...ref, available: 26, waitlist_enabled: true });
});

const msg = (type: string, data: object | null, extra: object = {}) =>
  JSON.stringify({ message_id: 'm1', type, version: 1, occurred_at: '2030-01-01T00:00:00Z', trace_id: 'c1', data, ...extra });
const seat = { registration_id: 'r1', event_id: 'e1', activity_id: 'a1', user_id: 'u1' };

test('registration.requested asks for a seat; cancelled and expired give it back', () => {
  const r = parseCommand(msg('registration.requested', seat));
  assert.ok(r.ok);
  assert.deepEqual(r.value, {
    messageId: 'm1', type: 'registration.requested', traceId: 'c1',
    command: { kind: 'reserve', registrationId: 'r1', eventId: 'e1', activityId: 'a1', userId: 'u1' },
  });
  for (const type of ['registration.cancelled', 'registration.expired']) {
    const p = parseCommand(msg(type, seat));
    assert.ok(p.ok && p.value.command?.kind === 'release');
  }
});

test('other types are ignored, not errors; user_id and trace_id are optional', () => {
  const r = parseCommand(msg('checkin.registered', { anything: 1 }));
  assert.ok(r.ok && r.value.command === null);
  const p = parseCommand(msg('registration.requested', { ...seat, user_id: undefined }, { trace_id: undefined }));
  assert.ok(p.ok && p.value.command?.userId === null && p.value.traceId === null);
});

test('the old correlation_id field is ignored: the message parses with a null trace id', () => {
  const p = parseCommand(msg('registration.requested', seat, { trace_id: undefined, correlation_id: 'old' }));
  assert.ok(p.ok && p.value.traceId === null && p.value.command?.kind === 'reserve');
});

test('malformed messages are rejected with a reason', () => {
  assert.deepEqual(parseCommand('nope'), { ok: false, error: 'invalid JSON' });
  assert.deepEqual(parseCommand('[]'), { ok: false, error: 'message must be a JSON object' });
  assert.deepEqual(parseCommand(msg('registration.requested', { ...seat, activity_id: ' ' })), { ok: false, error: 'activity_id is required' });
  assert.deepEqual(parseCommand(msg('registration.requested', { ...seat, event_id: 7 })), { ok: false, error: 'event_id must be a string' });
  assert.deepEqual(parseCommand(msg('registration.requested', seat, { version: 2 })), { ok: false, error: 'unsupported version 2' });
  assert.deepEqual(parseCommand(msg('registration.requested', seat, { message_id: '' })), { ok: false, error: 'message_id is required' });
  assert.deepEqual(parseCommand(msg('registration.requested', null)), { ok: false, error: 'data must be an object' });
});
