import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SeatCommand } from '../../src/messaging/commands.ts';
import { openActivity, organizer, outbox, reset, setup, skip } from './helpers.ts';

type Env = Awaited<ReturnType<typeof setup>>;

describe('seat reservation saga (RN01, RN03, RN04, idempotent consumer)', { skip }, () => {
  let env: Env;
  before(async () => { env = await setup(); });
  beforeEach(async () => { await reset(env.pool); });
  after(async () => { await env.pool.end(); });

  const command = (kind: SeatCommand['kind'], a: { id: string; event_id: string }, registrationId = randomUUID()): SeatCommand =>
    ({ kind, registrationId, eventId: a.event_id, activityId: a.id, userId: 'user-1' });
  const send = (c: SeatCommand, messageId: string = randomUUID()) => env.seats.handle(messageId, 'trace-9', c);

  async function seatState(activityId: string) {
    const res = await env.pool.query(
      `SELECT a.reserved, a.available,
              (SELECT count(*)::int FROM seat_reservations r WHERE r.activity_id = a.id AND r.status = 'HELD') AS held
         FROM activities a WHERE a.id = $1`, [activityId]);
    return res.rows[0] as { reserved: number; available: number; held: number };
  }

  async function seatMessages() {
    return (await outbox(env.pool)).filter((m) => m.type.startsWith('seat.'));
  }

  test('reserving answers seat.reserved with the price, keyed by registration', async () => {
    const { activity } = await openActivity(env.events, { price_cents: 3500 });
    const c = command('reserve', activity);
    assert.equal(await send(c), 'RESERVED');
    assert.deepEqual(await seatState(activity.id), { reserved: 1, available: 9, held: 1 });
    const [m] = await seatMessages();
    assert.equal(m.type, 'seat.reserved');
    assert.equal(m.key, c.registrationId);
    assert.equal(m.trace_id, 'trace-9');
    assert.deepEqual(m.data, {
      registration_id: c.registrationId, event_id: activity.event_id, activity_id: activity.id, user_id: 'user-1',
      price_cents: 3500, currency: 'BRL', paid: true, available: 9,
    });
  });

  test('a redelivered message is applied once; a retried request gets the same answer without a second seat', async () => {
    const { activity } = await openActivity(env.events);
    const c = command('reserve', activity);
    const id = randomUUID();
    assert.equal(await send(c, id), 'RESERVED');
    assert.equal(await send(c, id), 'DUPLICATE');
    assert.equal(await send(c), 'ALREADY_HELD');
    assert.deepEqual(await seatState(activity.id), { reserved: 1, available: 9, held: 1 });
    assert.deepEqual((await seatMessages()).map((m) => m.type), ['seat.reserved', 'seat.reserved']);
  });

  test('a full activity rejects with FULL and tells whether the waitlist is enabled', async () => {
    const { activity } = await openActivity(env.events, { capacity: 1, waitlist_enabled: true });
    assert.equal(await send(command('reserve', activity)), 'RESERVED');
    assert.equal(await send(command('reserve', activity)), 'REJECTED_FULL');
    const rejected = (await seatMessages()).at(-1)!;
    assert.equal(rejected.type, 'seat.rejected');
    assert.equal(rejected.data.reason, 'FULL');
    assert.equal(rejected.data.waitlist_enabled, true);
  });

  test('refusals for unknown, mismatched, malformed, draft and cancelled targets', async () => {
    const { activity, event } = await openActivity(env.events);
    assert.equal(await send({ ...command('reserve', activity), activityId: randomUUID() }), 'REJECTED_ACTIVITY_NOT_FOUND');
    assert.equal(await send({ ...command('reserve', activity), eventId: randomUUID() }), 'REJECTED_ACTIVITY_NOT_FOUND');
    assert.equal(await send({ ...command('reserve', activity), activityId: 'not-a-uuid' }), 'REJECTED_ACTIVITY_NOT_FOUND');

    const draft = await env.events.createEvent(organizer, { title: 'D', starts_at: event.starts_at, ends_at: event.ends_at });
    const draftActivity = await env.events.addActivity(organizer, draft.id, {
      title: 'x', starts_at: activity.starts_at, ends_at: activity.ends_at, capacity: 5,
    });
    assert.equal(await send(command('reserve', draftActivity)), 'REJECTED_EVENT_NOT_OPEN');

    await env.events.cancelEvent(organizer, event.id);
    assert.equal(await send(command('reserve', activity)), 'REJECTED_EVENT_NOT_OPEN');
  });

  test('releasing frees the seat once (RN03/RN04); releasing what was never held does nothing', async () => {
    const { activity } = await openActivity(env.events, { capacity: 1 });
    const c = command('reserve', activity);
    await send(c);
    assert.equal(await send({ ...c, kind: 'release' }), 'RELEASED');
    assert.equal(await send({ ...c, kind: 'release' }), 'NOT_HELD');
    assert.equal(await send(command('release', activity)), 'NOT_HELD');
    assert.deepEqual(await seatState(activity.id), { reserved: 0, available: 1, held: 0 });
    const released = (await seatMessages()).at(-1)!;
    assert.equal(released.type, 'seat.released');
    assert.equal(released.data.available, 1);

    // The freed seat can go to the next one (e.g. from the waitlist), and the first registration may come back.
    assert.equal(await send(command('reserve', activity)), 'RESERVED');
    assert.equal(await send(c), 'REJECTED_FULL');
  });

  test('RN01 under concurrency: 200 simultaneous requests for 25 seats never overbook', async () => {
    const { activity } = await openActivity(env.events, { capacity: 25 });
    const outcomes = await Promise.all(Array.from({ length: 200 }, () => send(command('reserve', activity))));
    const count = (o: string) => outcomes.filter((x) => x === o).length;
    assert.equal(count('RESERVED'), 25);
    assert.equal(count('REJECTED_FULL'), 175);
    assert.deepEqual(await seatState(activity.id), { reserved: 25, available: 0, held: 25 });
  });

  test('concurrent releases and new requests keep the counter equal to the seats held', async () => {
    const { activity } = await openActivity(env.events, { capacity: 20 });
    const first = Array.from({ length: 20 }, () => command('reserve', activity));
    await Promise.all(first.map((c) => send(c)));
    const mixed = [
      ...first.slice(0, 10).map((c) => send({ ...c, kind: 'release' })),
      ...first.slice(0, 10).map((c) => send({ ...c, kind: 'release' })), // duplicates of the releases
      ...Array.from({ length: 30 }, () => send(command('reserve', activity))),
    ];
    const outcomes = await Promise.all(mixed);
    const state = await seatState(activity.id);
    assert.equal(outcomes.filter((o) => o === 'RELEASED').length, 10);
    assert.equal(state.reserved, state.held);
    assert.ok(state.reserved <= 20);
    assert.equal(state.reserved, 10 + outcomes.filter((o) => o === 'RESERVED').length);
  });
});
