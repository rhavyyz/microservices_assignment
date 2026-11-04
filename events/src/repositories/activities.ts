import type { Queryable } from '../db/pool.ts';
import { insertRow, lockClause, updateColumns } from '../db/sql.ts';
import type { ActivityRow } from '../domain/model.ts';

/** Columns an organizer can edit. `capacity` is deliberately absent: it is immutable after creation. */
export const EDITABLE_ACTIVITY_COLUMNS = [
  'title', 'description', 'speaker', 'location', 'starts_at', 'ends_at', 'price_cents', 'waitlist_enabled',
] as const;

export type NewActivity = Pick<ActivityRow, 'id' | 'event_id' | 'capacity' | (typeof EDITABLE_ACTIVITY_COLUMNS)[number]>;

export function insertActivity(q: Queryable, a: NewActivity): Promise<ActivityRow> {
  return insertRow<ActivityRow>(q, 'activities', a);
}

export async function findActivity(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<ActivityRow | null> {
  const res = await q.query(`SELECT * FROM activities WHERE id = $1${lockClause(opts.forUpdate)}`, [id]);
  return (res.rows[0] as ActivityRow | undefined) ?? null;
}

export async function listActivities(q: Queryable, eventId: string): Promise<ActivityRow[]> {
  const res = await q.query('SELECT * FROM activities WHERE event_id = $1 ORDER BY starts_at, id', [eventId]);
  return res.rows as ActivityRow[];
}

export async function countActivities(q: Queryable, eventId: string): Promise<number> {
  const res = await q.query('SELECT count(*)::int AS n FROM activities WHERE event_id = $1', [eventId]);
  return (res.rows[0] as { n: number }).n;
}

export function updateActivity(q: Queryable, id: string, patch: Partial<ActivityRow>): Promise<ActivityRow> {
  return updateColumns<ActivityRow>(q, 'activities', id, patch, EDITABLE_ACTIVITY_COLUMNS);
}

export async function deleteActivity(q: Queryable, id: string): Promise<void> {
  await q.query('DELETE FROM activities WHERE id = $1', [id]);
}

/**
 * RN01, the only overbooking-safe step: one conditional UPDATE. Concurrent reservations of the same
 * activity queue on its row lock and PostgreSQL re-checks `reserved < capacity` on the latest row version
 * before applying each one, so the counter can never pass the capacity (the CHECK constraint backs it up).
 * Returns the updated activity, or null when no seat could be taken.
 */
export async function takeSeat(q: Queryable, activityId: string, eventId: string): Promise<ActivityRow | null> {
  const res = await q.query(
    `UPDATE activities a
        SET reserved = a.reserved + 1, updated_at = now()
       FROM events e
      WHERE a.id = $1 AND a.event_id = $2 AND e.id = a.event_id
        AND e.status = 'PUBLISHED'
        AND a.starts_at > now()
        AND a.reserved < a.capacity
     RETURNING a.*`,
    [activityId, eventId],
  );
  return (res.rows[0] as ActivityRow | undefined) ?? null;
}

/** Gives back one seat (the caller checked that the registration held it). */
export async function giveBackSeat(q: Queryable, activityId: string): Promise<ActivityRow> {
  const res = await q.query(
    'UPDATE activities SET reserved = reserved - 1, updated_at = now() WHERE id = $1 RETURNING *',
    [activityId],
  );
  return res.rows[0] as ActivityRow;
}
