import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createActivityAutoEnd } from '../../src/jobs/auto-end.ts';
import { AppError } from '../../src/errors.ts';
import {
  activityInput, ctx, eventInput, moveToPast, organizer, otherOrganizer, outbox, reset, setup, skip, TOPIC,
} from './helpers.ts';

type Env = Awaited<ReturnType<typeof setup>>;

/** Awaits a refused operation and checks its status and code. */
async function refused(p: Promise<unknown>, status: number, code: string) {
  await assert.rejects(p, (e: unknown) => e instanceof AppError && e.status === status && e.code === code);
}

describe('events and schedule (RF02, RF03, RF04, RN07)', { skip }, () => {
  let env: Env;
  before(async () => { env = await setup(); });
  beforeEach(async () => { await reset(env.pool); env.audits.length = 0; });
  after(async () => { await env.pool.end(); });

  test('creating an event stores a draft and queues EventCreated in the same transaction', async () => {
    const e = await env.events.createEvent(organizer, eventInput({ organization: 'UECE' }));
    assert.equal(e.status, 'DRAFT');
    assert.equal(e.organizer_id, organizer.actor.userId);
    assert.equal(e.description, null);

    const [m] = await outbox(env.pool);
    assert.equal(m.topic, TOPIC);
    assert.equal(m.type, 'EventCreated');
    assert.equal(m.key, e.event_id);
    assert.equal(m.trace_id, 'trace-1');
    assert.equal(m.organizer_id, organizer.actor.userId);
    assert.equal(m.name, 'Semana de Computação');
    assert.deepEqual(env.audits.at(-1), {
      operation: 'EVENT_CREATE', user_id: organizer.actor.userId, trace_id: 'trace-1', event_id: e.event_id, result: 'SUCCESS',
    });
  });

  test('participants cannot create events; the refusal is audited and nothing is written', async () => {
    await refused(env.events.createEvent(ctx('p1', ['PARTICIPANT']), eventInput()), 403, 'FORBIDDEN');
    assert.equal((await outbox(env.pool)).length, 0);
    assert.equal(env.audits.at(-1)?.result, 'FAILURE');
    assert.equal(env.audits.at(-1)?.code, 'FORBIDDEN');
  });

  test("another organizer's event is a 404 for every change (RN07)", async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    const a = await env.events.addActivity(organizer, e.event_id, activityInput(e));
    await refused(env.events.updateEvent(otherOrganizer, e.event_id, { title: 'x' }), 404, 'NOT_FOUND');
    await refused(env.events.publishEvent(otherOrganizer, e.event_id), 404, 'NOT_FOUND');
    await refused(env.events.cancelEvent(otherOrganizer, e.event_id), 404, 'NOT_FOUND');
    await refused(env.events.addActivity(otherOrganizer, e.event_id, activityInput(e)), 404, 'NOT_FOUND');
    await refused(env.events.updateActivity(otherOrganizer, a.activity_id, { title: 'x' }), 404, 'NOT_FOUND');
    await refused(env.events.deleteActivity(otherOrganizer, a.activity_id), 404, 'NOT_FOUND');
  });

  test('periods: invalid, activity outside the event, and moving the event away from its activities', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    await refused(env.events.createEvent(organizer, eventInput({ ends_at: e.starts_at, starts_at: e.ends_at })), 422, 'INVALID_PERIOD');
    await refused(env.events.addActivity(organizer, e.event_id, activityInput(e, { starts_at: new Date(e.starts_at.getTime() - 1000) })), 422, 'ACTIVITY_OUTSIDE_EVENT');
    const a = await env.events.addActivity(organizer, e.event_id, activityInput(e));
    await refused(env.events.updateEvent(organizer, e.event_id, { starts_at: new Date(a.starts_at.getTime() + 1000) }), 422, 'ACTIVITY_OUTSIDE_EVENT');
    await refused(env.events.updateActivity(organizer, a.activity_id, { ends_at: new Date(e.ends_at.getTime() + 1000) }), 422, 'ACTIVITY_OUTSIDE_EVENT');
  });

  test('partial update changes only the given fields and can clear optional ones', async () => {
    const e = await env.events.createEvent(organizer, eventInput({ description: 'old', location: 'Fortaleza' }));
    const u = await env.events.updateEvent(organizer, e.event_id, { description: null, title: 'Nova' });
    assert.equal(u.title, 'Nova');
    assert.equal(u.description, null);
    assert.equal(u.location, 'Fortaleza');
    assert.ok(u.updated_at > e.updated_at);
    assert.deepEqual((await outbox(env.pool)).map((m) => m.type), ['EventCreated', 'EventUpdated']);
  });

  test('lifecycle: publish needs an activity; cancelled is final', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    await refused(env.events.publishEvent(organizer, e.event_id), 409, 'EVENT_WITHOUT_ACTIVITIES');
    await env.events.addActivity(organizer, e.event_id, activityInput(e));
    assert.equal((await env.events.publishEvent(organizer, e.event_id)).status, 'PUBLISHED');
    await refused(env.events.publishEvent(organizer, e.event_id), 409, 'INVALID_STATUS');
    assert.equal((await env.events.cancelEvent(organizer, e.event_id)).status, 'CANCELLED');
    await refused(env.events.cancelEvent(organizer, e.event_id), 409, 'EVENT_CANCELLED');
    await refused(env.events.updateEvent(organizer, e.event_id, { title: 'x' }), 409, 'EVENT_CANCELLED');
    await refused(env.events.addActivity(organizer, e.event_id, activityInput(e)), 409, 'EVENT_CANCELLED');
    assert.deepEqual((await outbox(env.pool)).map((m) => m.type),
      ['EventCreated', 'ActivityCreated', 'EventPublished', 'EventCancelled', 'ActivityCancelled']);
  });

  test('after publishing, the price is fixed and activities cannot be removed; other fields still change', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    const a = await env.events.addActivity(organizer, e.event_id, activityInput(e, { amount_minor: 2000 }));
    assert.equal(a.paid, true);
    assert.equal(a.capacity, 10);
    assert.equal(a.amount_minor, 2000);
    assert.equal('available' in a, false);
    await env.events.publishEvent(organizer, e.event_id);
    await refused(env.events.updateActivity(organizer, a.activity_id, { amount_minor: 1000 }), 409, 'EVENT_NOT_DRAFT');
    await refused(env.events.deleteActivity(organizer, a.activity_id), 409, 'EVENT_NOT_DRAFT');
    const u = await env.events.updateActivity(organizer, a.activity_id, { amount_minor: 2000, speaker: 'Ana', waitlist_enabled: true });
    assert.equal(u.speaker, 'Ana');
    assert.equal(u.waitlist_enabled, true);
    assert.equal(u.capacity, 10);
  });

  test('capacity is immutable even for a direct database write', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    const a = await env.events.addActivity(organizer, e.event_id, activityInput(e));
    await assert.rejects(env.pool.query('UPDATE activities SET capacity = 99 WHERE id = $1', [a.activity_id]), /capacity is immutable/);
  });

  test('a draft activity can be deleted and ActivityDeleted is published', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    const a = await env.events.addActivity(organizer, e.event_id, activityInput(e));
    await env.events.deleteActivity(organizer, a.activity_id);
    await refused(env.events.getActivity(organizer.actor, a.activity_id), 404, 'NOT_FOUND');
    const last = (await outbox(env.pool)).at(-1)!;
    assert.equal(last.type, 'ActivityDeleted');
    assert.equal(last.activity_id, a.activity_id);
  });

  test('drafts are private; published events and their schedule are public', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    const a = await env.events.addActivity(organizer, e.event_id, activityInput(e));
    await refused(env.events.getEvent(null, e.event_id), 404, 'NOT_FOUND');
    await refused(env.events.getActivity(otherOrganizer.actor, a.activity_id), 404, 'NOT_FOUND');
    assert.equal((await env.events.getEvent(organizer.actor, e.event_id)).activities.length, 1);

    await env.events.publishEvent(organizer, e.event_id);
    const pub = await env.events.getEvent(null, e.event_id);
    assert.equal(pub.activities[0].capacity, 10);
    assert.equal(pub.activities[0].lifecycle, 'OPEN');
    assert.equal(pub.activities[0].registration_open, true);
    assert.equal((await env.events.listEventActivities(null, e.event_id)).length, 1);
    assert.equal((await env.events.getActivity(null, a.activity_id)).activity_id, a.activity_id);
  });

  test('the organizer ends an activity only after its scheduled end; once, with ActivityEnded keyed by activity_id', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    const a = await env.events.addActivity(organizer, e.event_id, activityInput(e));
    await refused(env.events.endActivity(organizer, a.activity_id), 409, 'EVENT_NOT_OPEN'); // still a draft
    await env.events.publishEvent(organizer, e.event_id);
    await refused(env.events.endActivity(otherOrganizer, a.activity_id), 404, 'NOT_FOUND');
    await refused(env.events.endActivity(organizer, a.activity_id), 409, 'ACTIVITY_NOT_ENDED');

    await moveToPast(env.pool, a.activity_id, 1);
    const ended = await env.events.endActivity(organizer, a.activity_id);
    assert.equal(ended.lifecycle, 'ENDED');
    assert.ok(ended.ended_at);
    assert.equal(ended.registration_open, false);
    const again = await env.events.endActivity(organizer, a.activity_id);
    assert.deepEqual(again.ended_at, ended.ended_at);

    const ends = (await outbox(env.pool)).filter((m) => m.type === 'ActivityEnded');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].key, a.activity_id);
    assert.equal(ends[0].activity_id, a.activity_id);
    assert.equal(ends[0].event_id, e.event_id);
    assert.equal(ends[0].trace_id, 'trace-1');
    assert.equal((await env.events.getActivity(null, a.activity_id)).lifecycle, 'ENDED');
  });

  test('an ended activity can no longer be edited (409 ACTIVITY_ENDED) and nothing more is published', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    const a = await env.events.addActivity(organizer, e.event_id, activityInput(e));
    await env.events.publishEvent(organizer, e.event_id);
    await moveToPast(env.pool, a.activity_id, 1);
    await env.events.endActivity(organizer, a.activity_id);
    const before = (await outbox(env.pool)).length;

    await refused(env.events.updateActivity(organizer, a.activity_id, { speaker: 'Ana' }), 409, 'ACTIVITY_ENDED');
    await refused(env.events.updateActivity(organizer, a.activity_id, { ends_at: new Date(Date.now() + 3_600_000) }), 409, 'ACTIVITY_ENDED');
    assert.equal((await outbox(env.pool)).length, before);
    assert.equal((await env.events.getActivity(null, a.activity_id)).lifecycle, 'ENDED');
  });

  test('cancelling the event cancels the activities that have not ended and leaves the ended ones alone', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    const a1 = await env.events.addActivity(organizer, e.event_id, activityInput(e));
    const a2 = await env.events.addActivity(organizer, e.event_id, activityInput(e));
    await env.events.publishEvent(organizer, e.event_id);
    await moveToPast(env.pool, a2.activity_id, 1);
    await env.events.endActivity(organizer, a2.activity_id);
    await env.events.cancelEvent(organizer, e.event_id);

    const cancelled = (await outbox(env.pool)).filter((m) => m.type === 'ActivityCancelled');
    assert.deepEqual(cancelled.map((m) => [m.key, m.activity_id]), [[a1.activity_id, a1.activity_id]]);
    assert.equal((await env.events.getActivity(null, a1.activity_id)).lifecycle, 'CANCELLED'); // still consultable
  });

  test('the automatic end ends due activities of published events once, with a null trace id', async () => {
    const quiet = { info: () => {}, warn: () => {}, error: () => {} };
    const e = await env.events.createEvent(organizer, eventInput());
    const due = await env.events.addActivity(organizer, e.event_id, activityInput(e));
    const recent = await env.events.addActivity(organizer, e.event_id, activityInput(e));
    const open = await env.events.addActivity(organizer, e.event_id, activityInput(e));
    await env.events.publishEvent(organizer, e.event_id);
    await moveToPast(env.pool, due.activity_id, 30);
    await moveToPast(env.pool, recent.activity_id, 2); // ended two hours ago, one day has not passed

    const job = createActivityAutoEnd({ deps: env.deps, autoEndAfterSeconds: 86400, log: quiet });
    assert.equal(await job.runOnce(), 1);
    assert.equal(await job.runOnce(), 0);
    const ends = (await outbox(env.pool)).filter((m) => m.type === 'ActivityEnded');
    assert.deepEqual(ends.map((m) => [m.activity_id, m.trace_id]), [[due.activity_id, null]]);
    assert.equal((await env.events.getActivity(null, due.activity_id)).lifecycle, 'ENDED');
    assert.equal((await env.events.getActivity(null, recent.activity_id)).lifecycle, 'OPEN');
    assert.equal((await env.events.getActivity(null, open.activity_id)).lifecycle, 'OPEN');

    // A shorter delay catches the recent one too; two jobs running together never end one twice.
    const shorter = createActivityAutoEnd({ deps: env.deps, autoEndAfterSeconds: 3600, log: quiet });
    const other = createActivityAutoEnd({ deps: env.deps, autoEndAfterSeconds: 3600, log: quiet });
    const [x, y] = await Promise.all([shorter.runOnce(), other.runOnce()]);
    assert.equal(x + y, 1);
    assert.equal((await outbox(env.pool)).filter((m) => m.type === 'ActivityEnded').length, 2);
  });

  test('permissions: the organizer of the event manages the activity; others cannot, and cannot see a draft at all', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    const a = await env.events.addActivity(organizer, e.event_id, activityInput(e));
    assert.deepEqual(await env.events.getPermissions(organizer.actor, a.activity_id), { can_manage: true });
    await refused(env.events.getPermissions(otherOrganizer.actor, a.activity_id), 404, 'NOT_FOUND');
    await env.events.publishEvent(organizer, e.event_id);
    assert.deepEqual(await env.events.getPermissions(otherOrganizer.actor, a.activity_id), { can_manage: false });
  });

  test('the ended_at column and the legacy columns: the migration is idempotent and keeps them', async () => {
    const { migrate } = await import('../../src/db/pool.ts');
    await migrate(env.pool);
    const cols = (await env.pool.query("SELECT column_name FROM information_schema.columns WHERE table_name = 'activities'")).rows.map((r) => r.column_name);
    for (const c of ['ended_at', 'reserved', 'available', 'price_cents']) assert.ok(cols.includes(c), c);
  });

  test('search lists published events only, with text and period filters and pagination', async () => {
    const base = eventInput();
    const later = eventInput({ starts_at: new Date(base.starts_at.getTime() + 30 * 86400000), ends_at: new Date(base.starts_at.getTime() + 31 * 86400000) });
    const titles = ['Workshop de Docker', 'Congresso 50%_off', 'Seminário de IA'];
    for (const [i, title] of titles.entries()) {
      const e = await env.events.createEvent(organizer, { ...(i === 2 ? later : base), title });
      await env.events.addActivity(organizer, e.event_id, activityInput(e));
      await env.events.publishEvent(organizer, e.event_id);
    }
    await env.events.createEvent(organizer, eventInput({ title: 'Rascunho de Docker' }));
    const q = { limit: 20, offset: 0 };

    assert.equal((await env.events.listPublished(q)).total, 3);
    assert.deepEqual((await env.events.listPublished({ ...q, text: 'docker' })).items.map((e) => e.title), ['Workshop de Docker']);
    assert.deepEqual((await env.events.listPublished({ ...q, text: '%_' })).items.map((e) => e.title), ['Congresso 50%_off']);
    assert.deepEqual((await env.events.listPublished({ ...q, from: later.starts_at })).items.map((e) => e.title), ['Seminário de IA']);
    assert.equal((await env.events.listPublished({ ...q, to: base.ends_at })).total, 2);
    const page2 = await env.events.listPublished({ limit: 2, offset: 2 });
    assert.deepEqual([page2.items.length, page2.total, page2.limit, page2.offset], [1, 3, 2, 2]);

    assert.equal((await env.events.listOwn(organizer.actor, q)).total, 4);
    assert.equal((await env.events.listOwn(otherOrganizer.actor, q)).total, 0);
  });
});
