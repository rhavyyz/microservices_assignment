import type { Queryable } from '../db/pool.ts';
import type { ReservationRow } from '../domain/model.ts';

/**
 * Serializes the messages about one registration until the transaction ends, even when they arrive on
 * different partitions or replicas, and even before its reservation row exists (a row lock could not).
 */
export async function lockRegistration(q: Queryable, registrationId: string): Promise<void> {
  await q.query("SELECT pg_advisory_xact_lock(hashtextextended('seat:' || $1, 0))", [registrationId]);
}

export async function findReservation(q: Queryable, registrationId: string): Promise<ReservationRow | null> {
  const res = await q.query('SELECT * FROM seat_reservations WHERE registration_id = $1', [registrationId]);
  return (res.rows[0] as ReservationRow | undefined) ?? null;
}

/** Records that the registration holds a seat (new, or again after it had been released). */
export async function holdReservation(
  q: Queryable,
  r: Pick<ReservationRow, 'registration_id' | 'activity_id' | 'event_id' | 'user_id'>,
): Promise<void> {
  await q.query(
    `INSERT INTO seat_reservations (registration_id, activity_id, event_id, user_id, status)
     VALUES ($1, $2, $3, $4, 'HELD')
     ON CONFLICT (registration_id) DO UPDATE SET
       activity_id = EXCLUDED.activity_id, event_id = EXCLUDED.event_id, user_id = EXCLUDED.user_id,
       status = 'HELD', updated_at = now()`,
    [r.registration_id, r.activity_id, r.event_id, r.user_id],
  );
}

export async function releaseReservation(q: Queryable, registrationId: string): Promise<void> {
  await q.query(
    `UPDATE seat_reservations SET status = 'RELEASED', updated_at = now() WHERE registration_id = $1`,
    [registrationId],
  );
}
