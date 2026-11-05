import test from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.ts';
import { d, fakeService, organizer, ORGANIZER_ID, other } from './fakes.ts';

async function refused(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof AppError && e.status === status && e.code === code);
}

test('only the organizer of the event can end the activity; someone else gets a 404 and nothing is written', async () => {
  const s = fakeService();
  s.db.seedEvent();
  s.db.seedActivity();
  await refused(s.events.endActivity(other, 'a1'), 404, 'NOT_FOUND');
  await refused(s.events.endActivity(organizer, 'missing'), 404, 'NOT_FOUND');
  assert.equal(s.db.outbox().length, 0);
  assert.equal(s.db.activity('a1').ended_at, null);
  assert.deepEqual(s.audits.at(-1), {
    operation: 'ACTIVITY_END', user_id: ORGANIZER_ID, trace_id: 'trace-1234', activity_id: 'missing', result: 'FAILURE', code: 'NOT_FOUND',
  });
});

test('an activity of an event that is not published cannot be ended (409 EVENT_NOT_OPEN)', async () => {
  for (const status of ['DRAFT', 'CANCELLED'] as const) {
    const s = fakeService();
    s.db.seedEvent({ status });
    s.db.seedActivity();
    await refused(s.events.endActivity(organizer, 'a1'), 409, 'EVENT_NOT_OPEN');
    assert.equal(s.db.outbox().length, 0);
  }
});

test('ending before the scheduled end is a 409 ACTIVITY_NOT_ENDED and publishes nothing', async () => {
  const s = fakeService(d('2030-05-01T09:59:59Z'));
  s.db.seedEvent();
  s.db.seedActivity();
  await refused(s.events.endActivity(organizer, 'a1'), 409, 'ACTIVITY_NOT_ENDED');
  assert.equal(s.db.outbox().length, 0);
  assert.equal(s.db.activity('a1').ended_at, null);
});

test('ending at the scheduled end succeeds and publishes ActivityEnded once, keyed by activity_id', async () => {
  const s = fakeService(d('2030-05-01T10:00:00Z'));
  s.db.seedEvent();
  s.db.seedActivity();
  const a = await s.events.endActivity(organizer, 'a1');
  assert.equal(a.lifecycle, 'ENDED');
  assert.equal(a.registration_open, false);
  assert.equal(a.ended_at?.toISOString(), '2030-05-01T10:00:00.000Z');
  const [m, ...rest] = s.db.outbox();
  assert.equal(rest.length, 0);
  assert.equal(m.type, 'ActivityEnded');
  assert.equal(m.key, 'a1');
  assert.equal(m.topic, 'events.events');
  assert.equal(m.schema_version, 1);
  assert.equal(m.trace_id, 'trace-1234');
  assert.equal(m.activity_id, 'a1');
  assert.equal(m.event_id, 'e1');
  assert.equal(m.ends_at, '2030-05-01T10:00:00.000Z');
  assert.deepEqual(s.audits.at(-1), {
    operation: 'ACTIVITY_END', user_id: organizer.actor.userId, trace_id: 'trace-1234', activity_id: 'a1', event_id: 'e1', result: 'SUCCESS',
  });
});

test('ending again is idempotent: 200 with the current activity and no new message', async () => {
  const s = fakeService();
  s.db.seedEvent();
  s.db.seedActivity();
  const first = await s.events.endActivity(organizer, 'a1');
  s.clock.now = d('2030-05-02T00:00:00Z');
  const again = await s.events.endActivity(organizer, 'a1');
  assert.equal(again.lifecycle, 'ENDED');
  assert.deepEqual(again.ended_at, first.ended_at);
  assert.equal(s.db.outbox().length, 1);
});

test('the ended activity stays consultable with its lifecycle, also for anonymous callers', async () => {
  const s = fakeService();
  s.db.seedEvent();
  s.db.seedActivity();
  await s.events.endActivity(organizer, 'a1');
  const a = await s.events.getActivity(null, 'a1');
  assert.equal(a.lifecycle, 'ENDED');
  assert.equal(a.registration_open, false);
});

test('cancelling the event publishes EventCancelled and one ActivityCancelled per activity that has not ended', async () => {
  const s = fakeService();
  s.db.seedEvent();
  s.db.seedActivity({ id: 'a1' });
  s.db.seedActivity({ id: 'a2', starts_at: d('2030-05-02T09:00:00Z'), ends_at: d('2030-05-02T10:00:00Z') });
  s.db.seedActivity({ id: 'a3', ended_at: d('2030-05-01T10:30:00Z') });
  const event = await s.events.cancelEvent(organizer, 'e1');
  assert.equal(event.status, 'CANCELLED');
  assert.equal(event.event_id, 'e1');
  const out = s.db.outbox();
  assert.deepEqual(out.map((m) => m.type), ['EventCancelled', 'ActivityCancelled', 'ActivityCancelled']);
  assert.deepEqual(out.map((m) => m.key), ['e1', 'a1', 'a2']);
  assert.deepEqual(out.slice(1).map((m) => m.activity_id), ['a1', 'a2']);
  assert.ok(out.every((m) => m.trace_id === 'trace-1234'));
  assert.equal(out[1].event_id, 'e1');
  assert.equal(out[1].ends_at, '2030-05-01T10:00:00.000Z');
});

test('a cancelled event cannot be cancelled again and publishes nothing more; its activities stay consultable as CANCELLED', async () => {
  const s = fakeService();
  s.db.seedEvent();
  s.db.seedActivity();
  await s.events.cancelEvent(organizer, 'e1');
  s.db.clearOutbox();
  await refused(s.events.cancelEvent(organizer, 'e1'), 409, 'EVENT_CANCELLED');
  assert.equal(s.db.outbox().length, 0);
  const a = await s.events.getActivity(null, 'a1');
  assert.equal(a.lifecycle, 'CANCELLED');
  assert.equal(a.registration_open, false);
});

test("another organizer cannot cancel the event: 404 and no ActivityCancelled", async () => {
  const s = fakeService();
  s.db.seedEvent();
  s.db.seedActivity();
  await refused(s.events.cancelEvent(other, 'e1'), 404, 'NOT_FOUND');
  assert.equal(s.db.outbox().length, 0);
});

test('permissions/me: true for the organizer, false for others on a public event, 404 for unknown or private activities', async () => {
  const s = fakeService();
  s.db.seedEvent();
  s.db.seedActivity();
  assert.deepEqual(await s.events.getPermissions(organizer.actor, 'a1'), { can_manage: true });
  assert.deepEqual(await s.events.getPermissions(other.actor, 'a1'), { can_manage: false });
  await refused(s.events.getPermissions(organizer.actor, 'missing'), 404, 'NOT_FOUND');

  const draft = fakeService();
  draft.db.seedEvent({ status: 'DRAFT' });
  draft.db.seedActivity();
  assert.deepEqual(await draft.events.getPermissions(organizer.actor, 'a1'), { can_manage: true });
  await refused(draft.events.getPermissions(other.actor, 'a1'), 404, 'NOT_FOUND');
});

test('activity representation: Subscription names, currency, lifecycle, registration_open and no seat counts', async () => {
  const s = fakeService(d('2030-05-01T08:30:00Z'));
  s.db.seedEvent();
  s.db.seedActivity();
  const a = await s.events.getActivity(null, 'a1');
  assert.deepEqual(Object.keys(a).sort(), [
    'activity_id', 'amount_minor', 'capacity', 'created_at', 'currency', 'description', 'ended_at', 'event_id', 'ends_at',
    'lifecycle', 'location', 'paid', 'registration_open', 'speaker', 'starts_at', 'title', 'updated_at', 'waitlist_enabled',
  ].sort());
  assert.equal(a.activity_id, 'a1');
  assert.equal(a.amount_minor, 5000);
  assert.equal(a.currency, 'BRL');
  assert.equal(a.paid, true);
  assert.equal(a.lifecycle, 'OPEN');
  assert.equal(a.ended_at, null);
  assert.equal(a.registration_open, true);

  s.clock.now = d('2030-05-01T09:00:00Z'); // started: registration closes, the activity is still OPEN
  const started = await s.events.getActivity(null, 'a1');
  assert.equal(started.registration_open, false);
  assert.equal(started.lifecycle, 'OPEN');
});

test('registration is closed while the event is a draft, and the event view uses event_id', async () => {
  const s = fakeService(d('2030-04-01T00:00:00Z'));
  s.db.seedEvent({ status: 'DRAFT' });
  s.db.seedActivity();
  const detail = await s.events.getEvent(organizer.actor, 'e1');
  assert.equal(detail.event_id, 'e1');
  assert.equal('id' in detail, false);
  assert.equal(detail.activities[0].registration_open, false);
  s.db.seedEvent({ status: 'PUBLISHED' });
  assert.equal((await s.events.getEvent(null, 'e1')).activities[0].registration_open, true);
});

test('creating and editing activities uses amount_minor and publishes PascalCase messages with it', async () => {
  const s = fakeService(d('2030-04-01T00:00:00Z'));
  const event = await s.events.createEvent(organizer, { title: 'Conf', starts_at: d('2030-05-01T08:00:00Z'), ends_at: d('2030-05-03T18:00:00Z') });
  const created = await s.events.addActivity(organizer, event.event_id, {
    title: 'Talk', starts_at: d('2030-05-01T09:00:00Z'), ends_at: d('2030-05-01T10:00:00Z'), capacity: 20, amount_minor: 2500,
  });
  assert.equal(created.amount_minor, 2500);
  assert.equal(created.paid, true);
  const updated = await s.events.updateActivity(organizer, created.activity_id, { amount_minor: 1000, speaker: 'Ana' });
  assert.equal(updated.amount_minor, 1000);
  assert.equal(updated.speaker, 'Ana');
  await s.events.deleteActivity(organizer, created.activity_id);
  const out = s.db.outbox();
  assert.deepEqual(out.map((m) => m.type), ['EventCreated', 'ActivityCreated', 'ActivityUpdated', 'ActivityDeleted']);
  assert.deepEqual(out.map((m) => m.key), Array(4).fill(event.event_id));
  assert.equal(out[1].amount_minor, 2500);
  assert.equal(out[1].currency, 'BRL');
  assert.equal('available' in out[1], false);
  assert.equal(out[2].amount_minor, 1000);
});
