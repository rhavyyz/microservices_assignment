// Integration test against a real PostgreSQL (TEST_DATABASE_URL); skipped without it. It uses the real
// migration, parser, projection and query functions. It DROPS and recreates the reports tables of that
// database: point it at a throwaway one.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { parseMessage } from '../../src/contracts.ts';
import { migrate } from '../../src/db.ts';
import { processMessage } from '../../src/projection.ts';
import {
  activitiesSection,
  activityLifecycleSection,
  attendanceSection,
  countActivities,
  countOwnedEvents,
  listOwnedEvents,
  occupancySection,
  paymentsSection,
  registrationsSection,
} from '../../src/queries.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl ? false : 'set TEST_DATABASE_URL to run the integration tests';

const TABLES = ['processed_messages', 'attendance_eligibility', 'checkins', 'payments', 'registrations', 'activities', 'events'];
let pool: pg.Pool | undefined;
const db = (): pg.Pool => (pool ??= new pg.Pool({ connectionString: databaseUrl, max: 4 }));
after(async () => {
  await pool?.end();
});

/** Empty, up-to-date schema. */
async function fresh(): Promise<pg.Pool> {
  const p = db();
  await migrate(p);
  await p.query(`TRUNCATE ${TABLES.join(', ')}`);
  return p;
}

test('migrate converts old-format rows and is idempotent', { skip }, async () => {
  const p = db();
  await p.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')}`);
  await migrate(p); // fresh database: every conversion is a no-op

  // Rebuild the pre-migration shape: no amount_minor column, old statuses, decimal amounts.
  await p.query('ALTER TABLE payments DROP COLUMN amount_minor');
  await p.query(
    `INSERT INTO registrations (registration_id, event_id, activity_id, status, last_event_at) VALUES
       ('r-pending', 'e1', 'a1', 'PENDING', now()), ('r-conf', 'e1', 'a1', 'CONFIRMED', now()),
       ('r-wait', 'e1', 'a1', 'WAITLISTED', now())`,
  );
  await p.query(
    `INSERT INTO payments (payment_id, event_id, activity_id, amount, currency, status, last_event_at) VALUES
       ('p-conf', 'e1', 'a1', 25.00, 'BRL', 'CONFIRMED', now()),
       ('p-ref', 'e1', 'a1', 10.50, 'USD', 'REFUSED', now()),
       ('p-pend', 'e1', 'a1', 0.05, 'BRL', 'PENDING', now()),
       ('p-none', 'e1', 'a1', NULL, NULL, 'EXPIRED', now())`,
  );

  await migrate(p);
  await migrate(p); // second run changes nothing

  const regs = await p.query('SELECT registration_id, status FROM registrations ORDER BY registration_id');
  assert.deepEqual(regs.rows, [
    { registration_id: 'r-conf', status: 'CONFIRMED' },
    { registration_id: 'r-pending', status: 'PENDING_PAYMENT' },
    { registration_id: 'r-wait', status: 'WAITLISTED' },
  ]);
  const pays = await p.query('SELECT payment_id, status, amount_minor::text AS amount_minor FROM payments ORDER BY payment_id');
  assert.deepEqual(pays.rows, [
    { payment_id: 'p-conf', status: 'APPROVED', amount_minor: '2500' },
    { payment_id: 'p-none', status: 'EXPIRED', amount_minor: null },
    { payment_id: 'p-pend', status: 'PENDING', amount_minor: '5' },
    { payment_id: 'p-ref', status: 'DECLINED', amount_minor: '1050' },
  ]);
  // The old column is left in place, untouched.
  const old = await p.query('SELECT amount::text AS amount FROM payments WHERE payment_id = $1', ['p-conf']);
  assert.equal(old.rows[0].amount, '25.00');
});

test('a realistic sequence is projected and reported, and replays change nothing', { skip }, async () => {
  const p = await fresh();

  const E = 'e0000000-0000-4000-8000-000000000001';
  const O = 'b0000000-0000-4000-8000-000000000001';
  const A1 = 'a0000000-0000-4000-8000-000000000001';
  const A2 = 'a0000000-0000-4000-8000-000000000002';
  const reg = (n: number) => `c0000000-0000-4000-8000-00000000000${n}`;
  const pay = (n: number) => `d0000000-0000-4000-8000-00000000000${n}`;

  const base = Date.parse('2026-11-01T12:00:00.000Z');
  let seq = 0;
  const sent: string[] = [];
  /** A flat-envelope message, one second after the previous one unless `at` (ms after base) is given. */
  const message = (type: string, fields: object, at?: number): string => {
    seq += 1;
    return JSON.stringify({
      ...fields,
      message_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      schema_version: 1,
      type,
      occurred_at: new Date(base + (at ?? seq * 1000)).toISOString(),
      trace_id: null,
    });
  };
  const apply = async (raw: string): Promise<'applied' | 'duplicate'> => {
    const parsed = parseMessage(raw);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    sent.push(raw);
    return processMessage(p, parsed.value);
  };
  const registration = (type: string, n: number, activity: string) =>
    apply(message(type, { registration_id: reg(n), event_id: E, activity_id: activity, user_id: `u${n}` }));
  const payment = (type: string, n: number, activity: string, amount_minor: number | null, currency: string | null) =>
    apply(message(type, { payment_id: pay(n), registration_id: reg(n), event_id: E, activity_id: activity, amount_minor, currency }));

  await apply(message('EventCreated', { event_id: E, organizer_id: O, name: 'Conf' }));
  await apply(message('EventPublished', { event_id: E, organizer_id: O }));
  await apply(message('ActivityCreated', { activity_id: A1, event_id: E, name: 'Alpha', capacity: 4, paid: true }));
  await apply(message('ActivityCreated', { activity_id: A2, event_id: E, name: 'Beta', capacity: 2, paid: true }));

  // Alpha: r1 PENDING_PAYMENT -> CONFIRMED, r2 pending payment, r3 offered, r4 waitlisted, r5 rejected, r6 cancelled.
  await registration('RegistrationPendingPayment', 1, A1);
  await registration('RegistrationConfirmed', 1, A1);
  await registration('RegistrationPendingPayment', 2, A1);
  await registration('RegistrationWaitlisted', 3, A1);
  await registration('WaitlistOffered', 3, A1);
  await registration('RegistrationWaitlisted', 4, A1);
  await registration('RegistrationRejected', 5, A1);
  await registration('RegistrationPendingPayment', 6, A1);
  await registration('RegistrationCancelled', 6, A1);
  // Beta: r7 confirmed, r8 expired.
  await registration('RegistrationConfirmed', 7, A2);
  await registration('RegistrationPendingPayment', 8, A2);
  await registration('RegistrationExpired', 8, A2);

  // Payments in two currencies (+ one without currency): created -> approved, declined, approved -> refunded.
  await payment('PaymentCreated', 1, A1, 2500, 'BRL');
  await payment('PaymentApproved', 1, A1, 2500, 'BRL');
  await payment('PaymentApproved', 2, A1, 1000, 'USD');
  await payment('PaymentDeclined', 3, A1, 500, 'BRL');
  await payment('PaymentApproved', 4, A2, 4000, 'BRL');
  await payment('PaymentRefunded', 4, A2, 4000, 'BRL');
  await payment('PaymentApproved', 5, A2, 1500, 'BRL');
  await payment('PaymentCreated', 6, A2, 300, 'BRL');
  await payment('PaymentApproved', 7, A1, 100, null);

  await apply(message('AttendanceRecorded', { registration_id: reg(1), event_id: E, activity_id: A1, user_id: 'u1' }));

  const snapshot = async () => ({
    registrations: await registrationsSection(p, E),
    payments: await paymentsSection(p, E),
    occupancy: await occupancySection(p, E),
    attendance: await attendanceSection(p, E),
    activities: await activitiesSection(p, E),
  });

  const expected = {
    registrations: { pending_payment: 1, offered: 1, confirmed: 2, waitlisted: 1, cancelled: 1, expired: 1, rejected: 1, total: 8 },
    payments: {
      pending: 1, approved: 4, declined: 1, expired: 0, cancelled: 0, refunded_count: 1,
      revenue: [
        { currency: 'BRL', amount_minor: 4000 }, // 2500 + 1500; the refunded 4000 is not revenue
        { currency: 'UNKNOWN', amount_minor: 100 },
        { currency: 'USD', amount_minor: 1000 },
      ],
      refunded: [{ currency: 'BRL', amount_minor: 4000 }],
    },
    // Held seats: r1 confirmed, r2 pending payment, r3 offered, r7 confirmed = 4 of 6.
    occupancy: { capacity: 6, occupied: 4, rate: 0.6667 },
    attendance: { confirmed: 2, checkins: 1, rate: 0.5, certificate_eligible: 0, certificate_eligible_rate: 0 },
    activities: [
      {
        activity_id: A1, name: 'Alpha', capacity: 4, paid: true, lifecycle: 'OPEN', ended_at: null,
        pending_payment: 1, offered: 1, confirmed: 1, waitlisted: 1, cancelled: 1, expired: 0, rejected: 1,
        payments_approved: 3,
        revenue: [
          { currency: 'BRL', amount_minor: 2500 }, { currency: 'UNKNOWN', amount_minor: 100 }, { currency: 'USD', amount_minor: 1000 },
        ],
        refunded: [],
        occupied: 3, occupancy_rate: 0.75, checkins: 1, attendance_rate: 1,
      },
      {
        activity_id: A2, name: 'Beta', capacity: 2, paid: true, lifecycle: 'OPEN', ended_at: null,
        pending_payment: 0, offered: 0, confirmed: 1, waitlisted: 0, cancelled: 0, expired: 1, rejected: 0,
        payments_approved: 1,
        revenue: [{ currency: 'BRL', amount_minor: 1500 }],
        refunded: [{ currency: 'BRL', amount_minor: 4000 }],
        occupied: 1, occupancy_rate: 0.5, checkins: 0, attendance_rate: 0,
      },
    ],
  };
  assert.deepEqual(await snapshot(), expected);

  // Replaying every message (same message_id) is a no-op.
  for (const raw of sent) {
    const parsed = parseMessage(raw);
    assert.ok(parsed.ok);
    assert.equal(await processMessage(p, parsed.value), 'duplicate');
  }
  assert.deepEqual(await snapshot(), expected);

  // A late, older message (new id, earlier occurred_at) does not undo the refund.
  const late = message('PaymentApproved', { payment_id: pay(4), event_id: E, activity_id: A2, amount_minor: 4000, currency: 'BRL' }, 1);
  assert.equal(await apply(late), 'applied');
  assert.deepEqual(await snapshot(), expected);

  // Migrating again over live data changes nothing.
  await migrate(p);
  assert.deepEqual(await snapshot(), expected);
});

test('pagination: owned events and activities, against real SQL', { skip }, async () => {
  const p = await fresh();
  const OWNER = 'b0000000-0000-4000-8000-0000000000a1';
  const OTHER = 'b0000000-0000-4000-8000-0000000000a2';
  const ev = (n: number) => `e0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  let seq = 0;
  const apply = async (type: string, fields: object) => {
    seq += 1;
    const raw = JSON.stringify({
      ...fields,
      message_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      schema_version: 1,
      type,
      occurred_at: new Date(Date.parse('2026-11-01T12:00:00.000Z') + seq * 1000).toISOString(),
      trace_id: null,
    });
    const parsed = parseMessage(raw);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    await processMessage(p, parsed.value);
  };

  // OWNER: e1..e4 dated (e3 and e4 share a start, tie broken by event_id), e5 has no date (sorts last).
  // Created out of order so that insertion order cannot explain the result.
  const day = (d: number) => `2026-12-0${d}T10:00:00.000Z`;
  const ownerEvents: [number, string | null][] = [[4, day(3)], [5, null], [2, day(2)], [3, day(3)], [1, day(1)]];
  for (const [n, starts_at] of ownerEvents) {
    await apply('EventCreated', { event_id: ev(n), organizer_id: OWNER, name: `E${n}`, starts_at });
  }
  for (const n of [6, 7]) await apply('EventCreated', { event_id: ev(n), organizer_id: OTHER, name: `E${n}`, starts_at: day(1) });

  const expectedOrder = [ev(1), ev(2), ev(3), ev(4), ev(5)];
  const ids = (rows: { event_id: string }[]) => rows.map((r) => r.event_id);

  // Counts are per owner.
  assert.equal(await countOwnedEvents(p, OWNER), 5);
  assert.equal(await countOwnedEvents(p, OTHER), 2);
  assert.equal(await countOwnedEvents(p, 'nobody'), 0);

  // First page: the first two in the list order (starts_at ascending, no date last, then event_id).
  assert.deepEqual(ids(await listOwnedEvents(p, OWNER, { limit: 2, offset: 0 })), [ev(1), ev(2)]);
  assert.deepEqual(ids(await listOwnedEvents(p, OTHER, { limit: 2, offset: 0 })), [ev(6), ev(7)]);

  // Consecutive pages are disjoint and together are the whole list, in order.
  const p1 = ids(await listOwnedEvents(p, OWNER, { limit: 2, offset: 0 }));
  const p2 = ids(await listOwnedEvents(p, OWNER, { limit: 2, offset: 2 }));
  const p3 = ids(await listOwnedEvents(p, OWNER, { limit: 2, offset: 4 }));
  assert.deepEqual([p1.length, p2.length, p3.length], [2, 2, 1]);
  assert.equal(new Set([...p1, ...p2, ...p3]).size, 5);
  assert.deepEqual([...p1, ...p2, ...p3], expectedOrder);

  // Beyond the end: empty list, the total is unaffected.
  assert.deepEqual(await listOwnedEvents(p, OWNER, { limit: 2, offset: 5 }), []);
  assert.deepEqual(await listOwnedEvents(p, OWNER, { limit: 20, offset: 100 }), []);
  assert.equal(await countOwnedEvents(p, OWNER), 5);

  // No page (null limit): everything, same order.
  assert.deepEqual(ids(await listOwnedEvents(p, OWNER)), expectedOrder);
  assert.equal((await listOwnedEvents(p, OTHER)).length, 2);

  // Activities: one event with 5 (names out of order, two share a name), plus per-activity figures.
  const E = ev(1);
  const act = (n: number) => `a0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  const reg = (n: number) => `c0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  const pay = (n: number) => `d0000000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
  const names: [number, string][] = [[3, 'Gamma'], [1, 'Alpha'], [5, 'Beta'], [4, 'Beta'], [2, 'Delta']];
  for (const [n, name] of names) {
    await apply('ActivityCreated', { activity_id: act(n), event_id: E, name, capacity: n, paid: true });
  }
  // An activity of another event must not leak in.
  await apply('ActivityCreated', { activity_id: act(9), event_id: ev(2), name: 'Zeta', capacity: 1, paid: true });
  // Alpha(1): 2 confirmed, 1 check-in, payments BRL+USD. Beta(4): 1 waitlisted. Beta(5): 1 pending payment, a refunded payment.
  for (const n of [1, 2]) {
    await apply('RegistrationConfirmed', { registration_id: reg(n), event_id: E, activity_id: act(1), user_id: `u${n}` });
  }
  await apply('RegistrationWaitlisted', { registration_id: reg(3), event_id: E, activity_id: act(4), user_id: 'u3' });
  await apply('RegistrationPendingPayment', { registration_id: reg(4), event_id: E, activity_id: act(5), user_id: 'u4' });
  await apply('AttendanceRecorded', { registration_id: reg(1), event_id: E, activity_id: act(1), user_id: 'u1' });
  await apply('PaymentApproved', { payment_id: pay(1), registration_id: reg(1), event_id: E, activity_id: act(1), amount_minor: 2500, currency: 'BRL' });
  await apply('PaymentApproved', { payment_id: pay(2), registration_id: reg(2), event_id: E, activity_id: act(1), amount_minor: 1000, currency: 'USD' });
  await apply('PaymentApproved', { payment_id: pay(3), registration_id: reg(4), event_id: E, activity_id: act(5), amount_minor: 700, currency: 'BRL' });
  await apply('PaymentRefunded', { payment_id: pay(3), registration_id: reg(4), event_id: E, activity_id: act(5), amount_minor: 700, currency: 'BRL' });

  // Order: name, then activity_id: Alpha(1), Beta(4), Beta(5), Delta(2), Gamma(3).
  const actOrder = [act(1), act(4), act(5), act(2), act(3)];
  const aids = (rows: { activity_id: string }[]) => rows.map((r) => r.activity_id);
  assert.equal(await countActivities(p, E), 5);
  assert.equal(await countActivities(p, ev(2)), 1);
  assert.equal(await countActivities(p, ev(3)), 0);

  const all = await activitiesSection(p, E);
  assert.deepEqual(aids(all), actOrder);

  const a1 = await activitiesSection(p, E, { limit: 2, offset: 0 });
  const a2 = await activitiesSection(p, E, { limit: 2, offset: 2 });
  const a3 = await activitiesSection(p, E, { limit: 2, offset: 4 });
  assert.deepEqual([a1.length, a2.length, a3.length], [2, 2, 1]);
  assert.deepEqual(aids([...a1, ...a2, ...a3]), actOrder);
  assert.deepEqual(await activitiesSection(p, E, { limit: 2, offset: 5 }), []);
  assert.equal(await countActivities(p, E), 5);

  // Figures inside a page equal those of the unpaginated list: a page changes which rows, not their values.
  assert.deepEqual([...a1, ...a2, ...a3], all);
  const alpha = a1[0];
  assert.equal(alpha.name, 'Alpha');
  assert.equal(alpha.confirmed, 2);
  assert.equal(alpha.checkins, 1);
  assert.equal(alpha.payments_approved, 2);
  assert.deepEqual(alpha.revenue, [{ currency: 'BRL', amount_minor: 2500 }, { currency: 'USD', amount_minor: 1000 }]);
  assert.deepEqual(alpha.refunded, []);
  assert.equal(a1[1].waitlisted, 1); // Beta(4)
  assert.equal(a2[0].activity_id, act(5));
  assert.equal(a2[0].pending_payment, 1);
  assert.deepEqual(a2[0].revenue, []);
  assert.deepEqual(a2[0].refunded, [{ currency: 'BRL', amount_minor: 700 }]);
});

// ---- activity lifecycle, attendance eligibility, check-ins vs cancelled registrations ----

const E = 'e0000000-0000-4000-8000-000000000001';
const id = (prefix: string, n: number) => `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const BASE = Date.parse('2026-11-01T12:00:00.000Z');

/** Applies flat-envelope messages: one second after the previous one unless `at` (seconds after BASE) is given. */
function sender(p: pg.Pool) {
  let seq = 0;
  return async (type: string, fields: object, at?: number, messageId?: string): Promise<'applied' | 'duplicate'> => {
    seq += 1;
    const raw = JSON.stringify({
      ...fields,
      message_id: messageId ?? `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
      schema_version: 1,
      type,
      occurred_at: new Date(BASE + (at ?? seq) * 1000).toISOString(),
      trace_id: null,
    });
    const parsed = parseMessage(raw);
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.error);
    return processMessage(p, parsed.value);
  };
}

const activityRow = async (p: pg.Pool, activityId: string) =>
  (await p.query(
    'SELECT event_id, name, capacity, paid, lifecycle, ended_at, last_event_at FROM activities WHERE activity_id = $1',
    [activityId],
  )).rows[0];

test('migrate adds the lifecycle columns and the eligibility table to an existing database, idempotently', { skip }, async () => {
  const p = db();
  await p.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')}`);
  await migrate(p);
  // Rebuild the previous shape and put a row in it.
  await p.query('ALTER TABLE activities DROP COLUMN lifecycle, DROP COLUMN ended_at');
  await p.query('DROP TABLE attendance_eligibility');
  await p.query(
    `INSERT INTO activities (activity_id, event_id, name, capacity, paid, last_event_at)
     VALUES ('old-a', 'e1', 'Old', 5, true, now())`,
  );

  await migrate(p);
  await migrate(p);

  const row = await activityRow(p, 'old-a');
  assert.equal(row.lifecycle, 'OPEN');
  assert.equal(row.ended_at, null);
  assert.equal(row.name, 'Old');
  const cols = await p.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'attendance_eligibility' ORDER BY column_name`,
  );
  assert.deepEqual(cols.rows.map((r) => r.column_name), [
    'attendance_percentage', 'attended_activities', 'event_id', 'last_event_at', 'registration_id', 'total_activities', 'user_id',
  ]);
  assert.deepEqual(await attendanceSection(p, 'e1'), {
    confirmed: 0, checkins: 0, rate: null, certificate_eligible: 0, certificate_eligible_rate: null,
  });
});

test('lifecycle messages that arrive before ActivityCreated leave a stub that the descriptive fields fill, lifecycle kept', { skip }, async () => {
  const p = await fresh();
  const send = sender(p);
  const [A1, A2, A3, A4, A5] = [1, 2, 3, 4, 5].map((n) => id('a', n));
  const reg = (n: number) => id('c', n);

  await send('EventCreated', { event_id: E, organizer_id: 'o1', name: 'Conf' });
  await send('ActivityEnded', { activity_id: A1, event_id: E, ends_at: '2026-12-01T18:00:00.000Z' }, 10);
  await send('ActivityCancelled', { activity_id: A2, event_id: E, ends_at: '2026-12-01T18:00:00.000Z' });
  await send('ActivityDeleted', { activity_id: A3, event_id: E }); // only the ids

  // Stubs: event from the message, nothing descriptive, epoch so that anything fills them.
  const stub = await activityRow(p, A1);
  assert.equal(stub.event_id, E);
  assert.deepEqual([stub.name, stub.capacity, stub.lifecycle], [null, null, 'ENDED']);
  assert.equal(stub.ended_at.toISOString(), new Date(BASE + 10_000).toISOString());
  assert.equal(stub.last_event_at.getTime(), 0);
  assert.deepEqual([(await activityRow(p, A2)).lifecycle, (await activityRow(p, A3)).lifecycle], ['CANCELLED', 'DELETED']);

  // The descriptive messages, even the oldest possible, fill the fields without touching the lifecycle.
  await send('ActivityCreated', { activity_id: A1, event_id: E, name: 'One', capacity: 5, paid: true }, 1);
  await send('ActivityCreated', { activity_id: A2, event_id: E, name: 'Two', capacity: 20, paid: false });
  await send('ActivityUpdated', { activity_id: A3, event_id: E, name: 'Three', capacity: 30, paid: false });
  await send('ActivityCreated', { activity_id: A4, event_id: E, name: 'Four', capacity: 10, paid: false });
  await send('ActivityCreated', { activity_id: A5, event_id: E, name: 'Five', capacity: 7, paid: false });
  await send('ActivityEnded', { activity_id: A5, event_id: E, ends_at: '2026-12-01T18:00:00.000Z' }); // after: last_event_at kept

  const one = await activityRow(p, A1);
  assert.deepEqual([one.name, one.capacity, one.paid, one.lifecycle], ['One', 5, true, 'ENDED']);
  assert.equal(one.ended_at.toISOString(), new Date(BASE + 10_000).toISOString());
  assert.equal(one.last_event_at.toISOString(), new Date(BASE + 1_000).toISOString());
  assert.deepEqual([(await activityRow(p, A2)).lifecycle, (await activityRow(p, A2)).capacity], ['CANCELLED', 20]);
  assert.deepEqual([(await activityRow(p, A3)).lifecycle, (await activityRow(p, A3)).name], ['DELETED', 'Three']);
  const five = await activityRow(p, A5);
  assert.equal(five.lifecycle, 'ENDED');
  assert.equal(five.last_event_at.getTime() < five.ended_at.getTime(), true, 'the lifecycle update leaves last_event_at alone');

  // Registrations: A4 two confirmed, A1 one pending payment, A2 and A3 one confirmed each.
  const regs: [number, string, string][] = [
    [1, 'RegistrationConfirmed', A4], [2, 'RegistrationConfirmed', A4], [3, 'RegistrationPendingPayment', A1],
    [4, 'RegistrationConfirmed', A2], [5, 'RegistrationConfirmed', A3],
  ];
  for (const [n, type, a] of regs) await send(type, { registration_id: reg(n), event_id: E, activity_id: a, user_id: `u${n}` });

  // Capacity: A1 5 + A4 10 + A5 7 = 22 (cancelled A2 and deleted A3 excluded). Occupied: r1, r2, r3 = 3 -> 3/22.
  assert.deepEqual(await occupancySection(p, E), { capacity: 22, occupied: 3, rate: 0.1364 });
  assert.deepEqual(await activityLifecycleSection(p, E), { open: 1, ended: 2, cancelled: 1 });
  assert.equal(await countActivities(p, E), 4);

  const list = await activitiesSection(p, E);
  assert.deepEqual(list.map((a) => [a.name, a.lifecycle]), [
    ['Five', 'ENDED'], ['Four', 'OPEN'], ['One', 'ENDED'], ['Two', 'CANCELLED'],
  ]); // Three (deleted) is absent
  const byName = Object.fromEntries(list.map((a) => [a.name, a]));
  assert.equal(byName.Five.ended_at?.toISOString(), new Date(BASE + 10_000).toISOString());
  assert.equal(byName.Four.ended_at, null);
  assert.deepEqual([byName.Four.occupied, byName.Four.occupancy_rate], [2, 0.2]);
  assert.deepEqual([byName.One.occupied, byName.One.occupancy_rate], [1, 0.2]);
  assert.deepEqual([byName.Five.occupied, byName.Five.occupancy_rate], [0, 0]);
  assert.deepEqual([byName.Two.capacity, byName.Two.occupancy_rate], [20, null]); // cancelled: no capacity-based rate
});

test('lifecycle only moves forward by rank, and applying a message twice changes nothing', { skip }, async () => {
  const p = await fresh();
  const send = sender(p);
  const [A, B] = [id('a', 1), id('a', 2)];
  const ends = '2026-12-01T18:00:00.000Z';
  await send('ActivityCreated', { activity_id: A, event_id: E, name: 'A', capacity: 5, paid: false });
  await send('ActivityCreated', { activity_id: B, event_id: E, name: 'B', capacity: 5, paid: false });

  await send('ActivityCancelled', { activity_id: A, event_id: E, ends_at: ends });
  const cancelled = await activityRow(p, A);
  assert.equal(cancelled.lifecycle, 'CANCELLED');
  assert.equal(cancelled.ended_at, null);

  // A late ActivityEnded (new message id, later occurred_at) does not regress CANCELLED and sets no ended_at.
  assert.equal(await send('ActivityEnded', { activity_id: A, event_id: E, ends_at: ends }), 'applied');
  assert.deepEqual(await activityRow(p, A), cancelled);

  // Same rank again (new id): no-op. The same message id again: duplicate, no-op.
  await send('ActivityCancelled', { activity_id: A, event_id: E, ends_at: ends });
  assert.equal(await send('ActivityCancelled', { activity_id: A, event_id: E, ends_at: ends }, 5, 'dup-1'), 'applied');
  assert.equal(await send('ActivityCancelled', { activity_id: A, event_id: E, ends_at: ends }, 5, 'dup-1'), 'duplicate');
  assert.deepEqual(await activityRow(p, A), cancelled);

  // Deleted wins over everything; a later Cancelled/Ended does not bring it back.
  await send('ActivityDeleted', { activity_id: A, event_id: E });
  await send('ActivityCancelled', { activity_id: A, event_id: E, ends_at: ends });
  await send('ActivityEnded', { activity_id: A, event_id: E, ends_at: ends });
  assert.equal((await activityRow(p, A)).lifecycle, 'DELETED');
  assert.deepEqual(await activityLifecycleSection(p, E), { open: 1, ended: 0, cancelled: 0 });

  // ended_at is the first ENDED's occurred_at; a second ENDED changes nothing; ENDED -> CANCELLED keeps it.
  await send('ActivityEnded', { activity_id: B, event_id: E, ends_at: ends }, 100);
  await send('ActivityEnded', { activity_id: B, event_id: E, ends_at: ends }, 200);
  const ended = await activityRow(p, B);
  assert.equal(ended.ended_at.toISOString(), new Date(BASE + 100_000).toISOString());
  await send('ActivityCancelled', { activity_id: B, event_id: E, ends_at: ends }, 300);
  const after = await activityRow(p, B);
  assert.deepEqual([after.lifecycle, after.ended_at.toISOString()], ['CANCELLED', ended.ended_at.toISOString()]);
});

test('AttendanceEligible: upsert guarded by last_event_at, certificate_eligible and its rate', { skip }, async () => {
  const p = await fresh();
  const send = sender(p);
  const A = id('a', 1);
  const reg = (n: number) => id('c', n);
  await send('ActivityCreated', { activity_id: A, event_id: E, name: 'A', capacity: 10, paid: false });
  // u1..u4 confirmed; u1..u3 checked in (3 people), u4 did not.
  for (const n of [1, 2, 3, 4]) {
    await send('RegistrationConfirmed', { registration_id: reg(n), event_id: E, activity_id: A, user_id: `u${n}` });
  }
  for (const n of [1, 2, 3]) {
    await send('AttendanceRecorded', { registration_id: reg(n), event_id: E, activity_id: A, user_id: `u${n}` });
  }
  assert.deepEqual(await attendanceSection(p, E), {
    confirmed: 4, checkins: 3, rate: 0.75, certificate_eligible: 0, certificate_eligible_rate: 0,
  });

  const eligible = (user: string, attended: number, total: number, pct: number, extra: object = {}) =>
    ({ event_id: E, user_id: user, attended_activities: attended, total_activities: total, attendance_percentage: pct, ...extra });
  await send('AttendanceEligible', eligible('u1', 3, 4, 75, { registration_id: reg(1), activity_id: A }), 500);
  await send('AttendanceEligible', eligible('u2', 4, 4, 100), 600);
  // Older message for u2 (arrives later, occurred earlier): does not overwrite.
  await send('AttendanceEligible', eligible('u2', 3, 4, 75, { registration_id: reg(2) }), 550);
  // Another event's eligible person is not counted here.
  await send('AttendanceEligible', { ...eligible('u9', 1, 1, 100), event_id: id('e', 9) }, 700);

  const u2 = (await p.query(
    `SELECT registration_id, attended_activities, total_activities, attendance_percentage::text AS pct
       FROM attendance_eligibility WHERE event_id = $1 AND user_id = 'u2'`, [E])).rows[0];
  assert.deepEqual(u2, { registration_id: null, attended_activities: 4, total_activities: 4, pct: '100.00' });

  // A newer message does update it (and keeps the known registration_id when the new one has none).
  await send('AttendanceEligible', eligible('u1', 4, 4, 100), 800);
  const u1 = (await p.query(
    `SELECT registration_id, attended_activities, attendance_percentage::text AS pct
       FROM attendance_eligibility WHERE event_id = $1 AND user_id = 'u1'`, [E])).rows[0];
  assert.deepEqual(u1, { registration_id: reg(1), attended_activities: 4, pct: '100.00' });

  // 2 eligible over 3 distinct people with a counted check-in.
  assert.deepEqual(await attendanceSection(p, E), {
    confirmed: 4, checkins: 3, rate: 0.75, certificate_eligible: 2, certificate_eligible_rate: 0.6667,
  });
});

test('a check-in only counts while its registration is CONFIRMED', { skip }, async () => {
  const p = await fresh();
  const send = sender(p);
  const [A1, A2] = [id('a', 1), id('a', 2)];
  const reg = (n: number) => id('c', n);
  await send('ActivityCreated', { activity_id: A1, event_id: E, name: 'A1', capacity: 10, paid: false });
  await send('ActivityCreated', { activity_id: A2, event_id: E, name: 'A2', capacity: 10, paid: false });
  const r = (type: string, n: number, a = A1) =>
    send(type, { registration_id: reg(n), event_id: E, activity_id: a, user_id: `u${n}` });
  const checkin = (n: number, a = A1) =>
    send('AttendanceRecorded', { registration_id: reg(n), event_id: E, activity_id: a, user_id: `u${n}` });
  const figures = async () => {
    const att = await attendanceSection(p, E);
    const [x1] = (await activitiesSection(p, E)).filter((a) => a.activity_id === A1);
    return { confirmed: att.confirmed, checkins: att.checkins, rate: att.rate, a1: [x1.checkins, x1.attendance_rate] };
  };

  await r('RegistrationConfirmed', 1);
  await r('RegistrationConfirmed', 2);
  await checkin(1);
  await checkin(2);
  assert.deepEqual(await figures(), { confirmed: 2, checkins: 2, rate: 1, a1: [2, 1] });

  // r2 is cancelled afterwards: its check-in stops counting (it used to give 2 / 1 = 2.0).
  await r('RegistrationCancelled', 2);
  assert.deepEqual(await figures(), { confirmed: 1, checkins: 1, rate: 1, a1: [1, 1] });

  // A check-in whose registration is unknown yet is not counted...
  await checkin(9, A2);
  assert.deepEqual(await figures(), { confirmed: 1, checkins: 1, rate: 1, a1: [1, 1] });
  const a2 = (await activitiesSection(p, E)).find((a) => a.activity_id === A2);
  assert.deepEqual([a2?.checkins, a2?.attendance_rate], [0, null]);

  // ...until the registration arrives as CONFIRMED.
  await r('RegistrationConfirmed', 9, A2);
  assert.deepEqual(await figures(), { confirmed: 2, checkins: 2, rate: 1, a1: [1, 1] });
  const a2b = (await activitiesSection(p, E)).find((a) => a.activity_id === A2);
  assert.deepEqual([a2b?.checkins, a2b?.attendance_rate], [1, 1]);

  // Re-confirmed registration: the (kept) check-in counts again. The check-in table itself never changed.
  await r('RegistrationConfirmed', 2);
  assert.deepEqual(await figures(), { confirmed: 3, checkins: 3, rate: 1, a1: [2, 1] });
  assert.equal((await p.query('SELECT count(*)::int AS n FROM checkins')).rows[0].n, 3);
});
