import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../../src/errors.ts';
import {
  activityInput, ctx, eventInput, organizer, otherOrganizer, outbox, reset, setup, skip, TOPIC,
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

  test('creating an event stores a draft and queues event.created in the same transaction', async () => {
    const e = await env.events.createEvent(organizer, eventInput({ organization: 'UECE' }));
    assert.equal(e.status, 'DRAFT');
    assert.equal(e.organizer_id, 'organizer-1');
    assert.equal(e.description, null);

    const [m] = await outbox(env.pool);
    assert.equal(m.topic, TOPIC);
    assert.equal(m.type, 'event.created');
    assert.equal(m.key, e.id);
    assert.equal(m.trace_id, 'trace-1');
    assert.equal(m.data.organizer_id, 'organizer-1');
    assert.equal(m.data.name, 'Semana de Computação');
    assert.deepEqual(env.audits.at(-1), {
      operation: 'EVENT_CREATE', user_id: 'organizer-1', trace_id: 'trace-1', event_id: e.id, result: 'SUCCESS',
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
    const a = await env.events.addActivity(organizer, e.id, activityInput(e));
    await refused(env.events.updateEvent(otherOrganizer, e.id, { title: 'x' }), 404, 'NOT_FOUND');
    await refused(env.events.publishEvent(otherOrganizer, e.id), 404, 'NOT_FOUND');
    await refused(env.events.cancelEvent(otherOrganizer, e.id), 404, 'NOT_FOUND');
    await refused(env.events.addActivity(otherOrganizer, e.id, activityInput(e)), 404, 'NOT_FOUND');
    await refused(env.events.updateActivity(otherOrganizer, a.id, { title: 'x' }), 404, 'NOT_FOUND');
    await refused(env.events.deleteActivity(otherOrganizer, a.id), 404, 'NOT_FOUND');
  });

  test('periods: invalid, activity outside the event, and moving the event away from its activities', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    await refused(env.events.createEvent(organizer, eventInput({ ends_at: e.starts_at, starts_at: e.ends_at })), 422, 'INVALID_PERIOD');
    await refused(env.events.addActivity(organizer, e.id, activityInput(e, { starts_at: new Date(e.starts_at.getTime() - 1000) })), 422, 'ACTIVITY_OUTSIDE_EVENT');
    const a = await env.events.addActivity(organizer, e.id, activityInput(e));
    await refused(env.events.updateEvent(organizer, e.id, { starts_at: new Date(a.starts_at.getTime() + 1000) }), 422, 'ACTIVITY_OUTSIDE_EVENT');
    await refused(env.events.updateActivity(organizer, a.id, { ends_at: new Date(e.ends_at.getTime() + 1000) }), 422, 'ACTIVITY_OUTSIDE_EVENT');
  });

  test('partial update changes only the given fields and can clear optional ones', async () => {
    const e = await env.events.createEvent(organizer, eventInput({ description: 'old', location: 'Fortaleza' }));
    const u = await env.events.updateEvent(organizer, e.id, { description: null, title: 'Nova' });
    assert.equal(u.title, 'Nova');
    assert.equal(u.description, null);
    assert.equal(u.location, 'Fortaleza');
    assert.ok(u.updated_at > e.updated_at);
    assert.deepEqual((await outbox(env.pool)).map((m) => m.type), ['event.created', 'event.updated']);
  });

  test('lifecycle: publish needs an activity; cancelled is final', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    await refused(env.events.publishEvent(organizer, e.id), 409, 'EVENT_WITHOUT_ACTIVITIES');
    await env.events.addActivity(organizer, e.id, activityInput(e));
    assert.equal((await env.events.publishEvent(organizer, e.id)).status, 'PUBLISHED');
    await refused(env.events.publishEvent(organizer, e.id), 409, 'INVALID_STATUS');
    assert.equal((await env.events.cancelEvent(organizer, e.id)).status, 'CANCELLED');
    await refused(env.events.cancelEvent(organizer, e.id), 409, 'EVENT_CANCELLED');
    await refused(env.events.updateEvent(organizer, e.id, { title: 'x' }), 409, 'EVENT_CANCELLED');
    await refused(env.events.addActivity(organizer, e.id, activityInput(e)), 409, 'EVENT_CANCELLED');
    assert.deepEqual((await outbox(env.pool)).map((m) => m.type),
      ['event.created', 'activity.created', 'event.published', 'event.cancelled']);
  });

  test('after publishing, the price is fixed and activities cannot be removed; other fields still change', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    const a = await env.events.addActivity(organizer, e.id, activityInput(e, { price_cents: 2000 }));
    assert.equal(a.paid, true);
    assert.equal(a.available, 10);
    await env.events.publishEvent(organizer, e.id);
    await refused(env.events.updateActivity(organizer, a.id, { price_cents: 1000 }), 409, 'EVENT_NOT_DRAFT');
    await refused(env.events.deleteActivity(organizer, a.id), 409, 'EVENT_NOT_DRAFT');
    const u = await env.events.updateActivity(organizer, a.id, { price_cents: 2000, speaker: 'Ana', waitlist_enabled: true });
    assert.equal(u.speaker, 'Ana');
    assert.equal(u.waitlist_enabled, true);
    assert.equal(u.capacity, 10);
  });

  test('capacity is immutable even for a direct database write', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    const a = await env.events.addActivity(organizer, e.id, activityInput(e));
    await assert.rejects(env.pool.query('UPDATE activities SET capacity = 99 WHERE id = $1', [a.id]), /capacity is immutable/);
  });

  test('a draft activity can be deleted and activity.deleted is published', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    const a = await env.events.addActivity(organizer, e.id, activityInput(e));
    await env.events.deleteActivity(organizer, a.id);
    await refused(env.events.getActivity(organizer.actor, a.id), 404, 'NOT_FOUND');
    const last = (await outbox(env.pool)).at(-1)!;
    assert.equal(last.type, 'activity.deleted');
    assert.equal(last.data.activity_id, a.id);
  });

  test('drafts are private; published events, their schedule and seats are public', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    const a = await env.events.addActivity(organizer, e.id, activityInput(e));
    await refused(env.events.getEvent(null, e.id), 404, 'NOT_FOUND');
    await refused(env.events.getActivity(otherOrganizer.actor, a.id), 404, 'NOT_FOUND');
    assert.equal((await env.events.getEvent(organizer.actor, e.id)).activities.length, 1);

    await env.events.publishEvent(organizer, e.id);
    const pub = await env.events.getEvent(null, e.id);
    assert.equal(pub.activities[0].available, 10);
    assert.equal((await env.events.listEventActivities(null, e.id)).length, 1);
    assert.equal((await env.events.getActivity(null, a.id)).id, a.id);
  });

  test('search lists published events only, with text and period filters and pagination', async () => {
    const base = eventInput();
    const later = eventInput({ starts_at: new Date(base.starts_at.getTime() + 30 * 86400000), ends_at: new Date(base.starts_at.getTime() + 31 * 86400000) });
    const titles = ['Workshop de Docker', 'Congresso 50%_off', 'Seminário de IA'];
    for (const [i, title] of titles.entries()) {
      const e = await env.events.createEvent(organizer, { ...(i === 2 ? later : base), title });
      await env.events.addActivity(organizer, e.id, activityInput(e));
      await env.events.publishEvent(organizer, e.id);
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
