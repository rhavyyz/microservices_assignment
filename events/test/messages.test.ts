import test from 'node:test';
import assert from 'node:assert/strict';
import type { ActivityRow, EventRow } from '../src/domain/model.ts';
import { envelope } from '../src/messaging/envelope.ts';
import { activityLifecycleMessage, activityMessage, eventMessage } from '../src/messaging/messages.ts';

const d = (s: string) => new Date(s);
const ev: EventRow = {
  id: 'e1', organizer_id: 'org', organization: 'UECE', title: 'Conf', description: 'x', location: null, banner_url: null,
  starts_at: d('2030-05-01T08:00:00Z'), ends_at: d('2030-05-03T18:00:00Z'), status: 'PUBLISHED',
  created_at: d('2026-01-01T00:00:00Z'), updated_at: d('2026-01-01T00:00:00Z'),
};
const act: ActivityRow = {
  id: 'a1', event_id: 'e1', title: 'Talk', description: null, speaker: 'Ana', location: 'Room 1',
  starts_at: d('2030-05-01T09:00:00Z'), ends_at: d('2030-05-01T10:00:00Z'), capacity: 30,
  price_cents: 5000, paid: true, waitlist_enabled: true, ended_at: null, created_at: d('2026-01-01T00:00:00Z'),
  updated_at: d('2026-01-01T00:00:00Z'),
};

test('envelope is flat with the shared contract fields (schema_version, no nested data)', () => {
  const e = envelope('EventCreated', { event_id: 'e1' }, 'trace', d('2030-01-01T00:00:00Z'));
  assert.match(e.message_id, /^[0-9a-f-]{36}$/);
  assert.deepEqual({ ...e, message_id: 'x' }, {
    event_id: 'e1', message_id: 'x', schema_version: 1, type: 'EventCreated', occurred_at: '2030-01-01T00:00:00.000Z', trace_id: 'trace',
  });
  assert.equal('data' in e, false);
  assert.equal('version' in e, false);
  assert.equal(envelope('t', {}, null).trace_id, null);
  assert.notEqual(envelope('t', {}, null).message_id, envelope('t', {}, null).message_id);
});

test('a message field can never override the envelope fields', () => {
  const e = envelope('Real', { type: 'Fake', message_id: 'fake', schema_version: 9, trace_id: 'fake' }, null);
  assert.equal(e.type, 'Real');
  assert.notEqual(e.message_id, 'fake');
  assert.equal(e.schema_version, 1);
  assert.equal(e.trace_id, null);
});

test('event messages are PascalCase, keyed by event_id, with name, organizer_id, status and period', () => {
  const m = eventMessage('EventPublished', ev);
  assert.equal(m.type, 'EventPublished');
  assert.equal(m.key, 'e1');
  assert.deepEqual(m.data, {
    event_id: 'e1', organizer_id: 'org', organization: 'UECE', name: 'Conf', status: 'PUBLISHED',
    starts_at: '2030-05-01T08:00:00.000Z', ends_at: '2030-05-03T18:00:00.000Z',
  });
});

test('activity messages are keyed by event and carry capacity, amount_minor and currency but no seat count', () => {
  const m = activityMessage('ActivityCreated', act);
  assert.equal(m.type, 'ActivityCreated');
  assert.equal(m.key, 'e1');
  assert.deepEqual(m.data, {
    activity_id: 'a1', event_id: 'e1', name: 'Talk', starts_at: '2030-05-01T09:00:00.000Z',
    ends_at: '2030-05-01T10:00:00.000Z', capacity: 30, amount_minor: 5000, currency: 'BRL',
    paid: true, waitlist_enabled: true,
  });
  for (const type of ['ActivityUpdated', 'ActivityDeleted'] as const) {
    const other = activityMessage(type, act);
    assert.equal(other.type, type);
    assert.equal(other.key, 'e1');
    assert.deepEqual(other.data, m.data);
  }
});

test('ActivityEnded and ActivityCancelled are keyed by activity_id and carry activity_id, event_id and ends_at', () => {
  for (const type of ['ActivityEnded', 'ActivityCancelled'] as const) {
    const m = activityLifecycleMessage(type, act);
    assert.equal(m.type, type);
    assert.equal(m.key, 'a1');
    assert.deepEqual(m.data, { activity_id: 'a1', event_id: 'e1', ends_at: '2030-05-01T10:00:00.000Z' });
  }
});
