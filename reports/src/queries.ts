import type { Pool } from 'pg';
import { ratio } from './metrics.ts';

export type EventRow = {
  event_id: string;
  organizer_id: string | null;
  name: string | null;
  status: string;
  starts_at: Date | null;
  ends_at: Date | null;
};

export async function findEvent(pool: Pool, eventId: string): Promise<EventRow | null> {
  const r = await pool.query<EventRow>(
    'SELECT event_id, organizer_id, name, status, starts_at, ends_at FROM events WHERE event_id = $1',
    [eventId],
  );
  return r.rows[0] ?? null;
}

/** A page of a list: `limit` rows after skipping `offset`. */
export type Page = { limit: number; offset: number };

export async function listOwnedEvents(pool: Pool, userId: string, page?: Page): Promise<EventRow[]> {
  const r = await pool.query<EventRow>(
    `SELECT event_id, organizer_id, name, status, starts_at, ends_at
       FROM events WHERE organizer_id = $1 ORDER BY starts_at NULLS LAST, event_id
       LIMIT $2 OFFSET $3`,
    [userId, page?.limit ?? null, page?.offset ?? 0], // LIMIT NULL = no limit
  );
  return r.rows;
}

export async function countOwnedEvents(pool: Pool, userId: string): Promise<number> {
  const r = await pool.query<{ total: number }>('SELECT count(*)::int AS total FROM events WHERE organizer_id = $1', [userId]);
  return r.rows[0].total;
}

export async function countActivities(pool: Pool, eventId: string): Promise<number> {
  const r = await pool.query<{ total: number }>('SELECT count(*)::int AS total FROM activities WHERE event_id = $1', [eventId]);
  return r.rows[0].total;
}

export type Money = { currency: string; amount_minor: number };

/** bigint and sum() come back from pg as strings: to a number, refusing anything beyond the safe-integer range. */
function toSafeNumber(v: string | number): number {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error(`amount out of the safe integer range: ${String(v)}`);
  return n;
}

/** Registrations holding a seat in Subscription: awaiting payment, offered from the waitlist, or confirmed. */
const HELD = `('PENDING_PAYMENT', 'OFFERED', 'CONFIRMED')`;

export async function registrationsSection(pool: Pool, eventId: string) {
  const r = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'PENDING_PAYMENT')::int AS pending_payment,
            count(*) FILTER (WHERE status = 'OFFERED')::int         AS offered,
            count(*) FILTER (WHERE status = 'CONFIRMED')::int       AS confirmed,
            count(*) FILTER (WHERE status = 'WAITLISTED')::int      AS waitlisted,
            count(*) FILTER (WHERE status = 'CANCELLED')::int       AS cancelled,
            count(*) FILTER (WHERE status = 'EXPIRED')::int         AS expired,
            count(*) FILTER (WHERE status = 'REJECTED')::int        AS rejected,
            count(*)::int                                           AS total
       FROM registrations WHERE event_id = $1`,
    [eventId],
  );
  return r.rows[0] as {
    pending_payment: number; offered: number; confirmed: number; waitlisted: number; cancelled: number;
    expired: number; rejected: number; total: number;
  };
}

type MoneyRow = { activity_id: string | null; status: string; currency: string; amount_minor: string };

/** Sum of the payments in `status`, one entry per currency (never mixed), sorted by currency. */
function moneyOf(rows: MoneyRow[], status: string, activityId?: string): Money[] {
  return rows
    .filter((m) => m.status === status && (activityId === undefined || m.activity_id === activityId))
    .map((m) => ({ currency: m.currency, amount_minor: toSafeNumber(m.amount_minor) }))
    .sort((a, b) => (a.currency < b.currency ? -1 : a.currency > b.currency ? 1 : 0));
}

async function moneyRows(pool: Pool, eventId: string, byActivity: boolean): Promise<MoneyRow[]> {
  const r = await pool.query<MoneyRow>(
    `SELECT ${byActivity ? 'activity_id' : 'NULL::text AS activity_id'}, status,
            COALESCE(currency, 'UNKNOWN') AS currency, sum(amount_minor)::text AS amount_minor
       FROM payments
      WHERE event_id = $1 AND status IN ('APPROVED', 'REFUNDED') AND amount_minor IS NOT NULL
      GROUP BY ${byActivity ? 'activity_id, ' : ''}status, COALESCE(currency, 'UNKNOWN')`,
    [eventId],
  );
  return r.rows;
}

export async function paymentsSection(pool: Pool, eventId: string) {
  const r = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'PENDING')::int   AS pending,
            count(*) FILTER (WHERE status = 'APPROVED')::int  AS approved,
            count(*) FILTER (WHERE status = 'DECLINED')::int  AS declined,
            count(*) FILTER (WHERE status = 'EXPIRED')::int   AS expired,
            count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
            count(*) FILTER (WHERE status = 'REFUNDED')::int  AS refunded_count
       FROM payments WHERE event_id = $1`,
    [eventId],
  );
  const counts = r.rows[0] as {
    pending: number; approved: number; declined: number; expired: number; cancelled: number; refunded_count: number;
  };
  const money = await moneyRows(pool, eventId, false);
  return {
    ...counts,
    revenue: moneyOf(money, 'APPROVED'),
    refunded: moneyOf(money, 'REFUNDED'),
  };
}

/** Occupied = seats held by PENDING_PAYMENT, OFFERED and CONFIRMED registrations (the waitlist holds none). */
export async function occupancySection(pool: Pool, eventId: string) {
  const r = await pool.query<{ capacity: number; occupied: number }>(
    `SELECT (SELECT COALESCE(sum(capacity), 0)::int FROM activities WHERE event_id = $1) AS capacity,
            (SELECT count(*)::int FROM registrations
              WHERE event_id = $1 AND status IN ${HELD})                                 AS occupied`,
    [eventId],
  );
  const { capacity, occupied } = r.rows[0];
  return { capacity, occupied, rate: ratio(occupied, capacity) };
}

export async function attendanceSection(pool: Pool, eventId: string) {
  const r = await pool.query<{ confirmed: number; checkins: number }>(
    `SELECT (SELECT count(*)::int FROM registrations WHERE event_id = $1 AND status = 'CONFIRMED') AS confirmed,
            (SELECT count(*)::int FROM checkins WHERE event_id = $1)                               AS checkins`,
    [eventId],
  );
  const { confirmed, checkins } = r.rows[0];
  return { confirmed, checkins, rate: ratio(checkins, confirmed) };
}

export async function activitiesSection(pool: Pool, eventId: string, page?: Page) {
  const r = await pool.query<{
    activity_id: string; name: string | null; capacity: number | null; paid: boolean;
    pending_payment: number; offered: number; confirmed: number; waitlisted: number; cancelled: number;
    expired: number; rejected: number; payments_approved: number; checkins: number;
  }>(
    `SELECT a.activity_id, a.name, a.capacity, a.paid,
            COALESCE(r.pending_payment, 0) AS pending_payment, COALESCE(r.offered, 0) AS offered,
            COALESCE(r.confirmed, 0) AS confirmed, COALESCE(r.waitlisted, 0) AS waitlisted,
            COALESCE(r.cancelled, 0) AS cancelled, COALESCE(r.expired, 0) AS expired,
            COALESCE(r.rejected, 0) AS rejected,
            COALESCE(p.payments_approved, 0) AS payments_approved,
            COALESCE(c.checkins, 0) AS checkins
       FROM activities a
       LEFT JOIN (SELECT activity_id,
                         count(*) FILTER (WHERE status = 'PENDING_PAYMENT')::int AS pending_payment,
                         count(*) FILTER (WHERE status = 'OFFERED')::int         AS offered,
                         count(*) FILTER (WHERE status = 'CONFIRMED')::int       AS confirmed,
                         count(*) FILTER (WHERE status = 'WAITLISTED')::int      AS waitlisted,
                         count(*) FILTER (WHERE status = 'CANCELLED')::int       AS cancelled,
                         count(*) FILTER (WHERE status = 'EXPIRED')::int         AS expired,
                         count(*) FILTER (WHERE status = 'REJECTED')::int        AS rejected
                    FROM registrations WHERE event_id = $1 GROUP BY activity_id) r USING (activity_id)
       LEFT JOIN (SELECT activity_id,
                         count(*) FILTER (WHERE status = 'APPROVED')::int AS payments_approved
                    FROM payments WHERE event_id = $1 GROUP BY activity_id) p USING (activity_id)
       LEFT JOIN (SELECT activity_id, count(*)::int AS checkins
                    FROM checkins WHERE event_id = $1 GROUP BY activity_id) c USING (activity_id)
      WHERE a.event_id = $1
      ORDER BY a.name NULLS LAST, a.activity_id
      LIMIT $2 OFFSET $3`,
    [eventId, page?.limit ?? null, page?.offset ?? 0], // LIMIT NULL = no limit
  );
  const money = await moneyRows(pool, eventId, true);
  return r.rows.map((row) => {
    const occupied = row.pending_payment + row.offered + row.confirmed;
    return {
      activity_id: row.activity_id,
      name: row.name,
      capacity: row.capacity,
      paid: row.paid,
      pending_payment: row.pending_payment,
      offered: row.offered,
      confirmed: row.confirmed,
      waitlisted: row.waitlisted,
      cancelled: row.cancelled,
      expired: row.expired,
      rejected: row.rejected,
      payments_approved: row.payments_approved,
      revenue: moneyOf(money, 'APPROVED', row.activity_id),
      refunded: moneyOf(money, 'REFUNDED', row.activity_id),
      occupied,
      occupancy_rate: ratio(occupied, row.capacity ?? 0),
      checkins: row.checkins,
      attendance_rate: ratio(row.checkins, row.confirmed),
    };
  });
}
