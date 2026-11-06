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
  attendanceSection,
  occupancySection,
  paymentsSection,
  registrationsSection,
} from '../../src/queries.ts';

const databaseUrl = process.env.TEST_DATABASE_URL;
const skip = databaseUrl ? false : 'set TEST_DATABASE_URL to run the integration tests';

const TABLES = ['processed_messages', 'checkins', 'payments', 'registrations', 'activities', 'events'];
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
    attendance: { confirmed: 2, checkins: 1, rate: 0.5 },
    activities: [
      {
        activity_id: A1, name: 'Alpha', capacity: 4, paid: true,
        pending_payment: 1, offered: 1, confirmed: 1, waitlisted: 1, cancelled: 1, expired: 0, rejected: 1,
        payments_approved: 3,
        revenue: [
          { currency: 'BRL', amount_minor: 2500 }, { currency: 'UNKNOWN', amount_minor: 100 }, { currency: 'USD', amount_minor: 1000 },
        ],
        refunded: [],
        occupied: 3, occupancy_rate: 0.75, checkins: 1, attendance_rate: 1,
      },
      {
        activity_id: A2, name: 'Beta', capacity: 2, paid: true,
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
