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

export async function listOwnedEvents(pool: Pool, userId: string): Promise<EventRow[]> {
  const r = await pool.query<EventRow>(
    `SELECT event_id, organizer_id, name, status, starts_at, ends_at
       FROM events WHERE organizer_id = $1 ORDER BY starts_at NULLS LAST, event_id`,
    [userId],
  );
  return r.rows;
}

export async function registrationsSection(pool: Pool, eventId: string) {
  const r = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'PENDING')::int    AS pending,
            count(*) FILTER (WHERE status = 'CONFIRMED')::int  AS confirmed,
            count(*) FILTER (WHERE status = 'WAITLISTED')::int AS waitlisted,
            count(*) FILTER (WHERE status = 'CANCELLED')::int  AS cancelled,
            count(*) FILTER (WHERE status = 'EXPIRED')::int    AS expired,
            count(*)::int                                      AS total
       FROM registrations WHERE event_id = $1`,
    [eventId],
  );
  return r.rows[0] as {
    pending: number; confirmed: number; waitlisted: number; cancelled: number; expired: number; total: number;
  };
}

export async function paymentsSection(pool: Pool, eventId: string) {
  const r = await pool.query(
    `SELECT count(*) FILTER (WHERE status = 'PENDING')::int   AS pending,
            count(*) FILTER (WHERE status = 'CONFIRMED')::int AS confirmed,
            count(*) FILTER (WHERE status = 'REFUSED')::int   AS refused,
            count(*) FILTER (WHERE status = 'EXPIRED')::int   AS expired,
            count(*) FILTER (WHERE status = 'CANCELLED')::int AS cancelled,
            COALESCE(sum(amount) FILTER (WHERE status = 'CONFIRMED'), 0)::float8 AS revenue
       FROM payments WHERE event_id = $1`,
    [eventId],
  );
  return r.rows[0] as {
    pending: number; confirmed: number; refused: number; expired: number; cancelled: number; revenue: number;
  };
}

/** Occupied = seats held by PENDING (reserved, awaiting payment) and CONFIRMED registrations. */
export async function occupancySection(pool: Pool, eventId: string) {
  const r = await pool.query<{ capacity: number; occupied: number }>(
    `SELECT (SELECT COALESCE(sum(capacity), 0)::int FROM activities WHERE event_id = $1) AS capacity,
            (SELECT count(*)::int FROM registrations
              WHERE event_id = $1 AND status IN ('PENDING', 'CONFIRMED'))               AS occupied`,
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

export async function activitiesSection(pool: Pool, eventId: string) {
  const r = await pool.query<{
    activity_id: string; name: string | null; capacity: number | null; paid: boolean;
    pending: number; confirmed: number; waitlisted: number; cancelled: number; expired: number;
    payments_confirmed: number; revenue: number; checkins: number;
  }>(
    `SELECT a.activity_id, a.name, a.capacity, a.paid,
            COALESCE(r.pending, 0) AS pending, COALESCE(r.confirmed, 0) AS confirmed,
            COALESCE(r.waitlisted, 0) AS waitlisted, COALESCE(r.cancelled, 0) AS cancelled,
            COALESCE(r.expired, 0) AS expired,
            COALESCE(p.payments_confirmed, 0) AS payments_confirmed, COALESCE(p.revenue, 0) AS revenue,
            COALESCE(c.checkins, 0) AS checkins
       FROM activities a
       LEFT JOIN (SELECT activity_id,
                         count(*) FILTER (WHERE status = 'PENDING')::int    AS pending,
                         count(*) FILTER (WHERE status = 'CONFIRMED')::int  AS confirmed,
                         count(*) FILTER (WHERE status = 'WAITLISTED')::int AS waitlisted,
                         count(*) FILTER (WHERE status = 'CANCELLED')::int  AS cancelled,
                         count(*) FILTER (WHERE status = 'EXPIRED')::int    AS expired
                    FROM registrations WHERE event_id = $1 GROUP BY activity_id) r USING (activity_id)
       LEFT JOIN (SELECT activity_id,
                         count(*) FILTER (WHERE status = 'CONFIRMED')::int AS payments_confirmed,
                         COALESCE(sum(amount) FILTER (WHERE status = 'CONFIRMED'), 0)::float8 AS revenue
                    FROM payments WHERE event_id = $1 GROUP BY activity_id) p USING (activity_id)
       LEFT JOIN (SELECT activity_id, count(*)::int AS checkins
                    FROM checkins WHERE event_id = $1 GROUP BY activity_id) c USING (activity_id)
      WHERE a.event_id = $1
      ORDER BY a.name NULLS LAST, a.activity_id`,
    [eventId],
  );
  return r.rows.map((row) => {
    const occupied = row.pending + row.confirmed;
    return {
      activity_id: row.activity_id,
      name: row.name,
      capacity: row.capacity,
      paid: row.paid,
      pending: row.pending,
      confirmed: row.confirmed,
      waitlisted: row.waitlisted,
      cancelled: row.cancelled,
      expired: row.expired,
      payments_confirmed: row.payments_confirmed,
      revenue: row.revenue,
      occupied,
      occupancy_rate: ratio(occupied, row.capacity ?? 0),
      checkins: row.checkins,
      attendance_rate: ratio(row.checkins, row.confirmed),
    };
  });
}
