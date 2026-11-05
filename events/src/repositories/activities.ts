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

export async function listActivities(q: Queryable, eventId: string, opts: { forUpdate?: boolean } = {}): Promise<ActivityRow[]> {
  const res = await q.query(`SELECT * FROM activities WHERE event_id = $1 ORDER BY starts_at, id${lockClause(opts.forUpdate)}`, [eventId]);
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

/** Marks the activity as ended at `at` (the caller checked that it was not). */
export async function markEnded(q: Queryable, id: string, at: Date): Promise<ActivityRow> {
  const res = await q.query(
    'UPDATE activities SET ended_at = $2, updated_at = now() WHERE id = $1 RETURNING *',
    [id, at],
  );
  return res.rows[0] as ActivityRow;
}

/**
 * Automatic end: activities of published events still open `afterSeconds` after their scheduled end are
 * ended now. `SKIP LOCKED` keeps replicas (and a concurrent edit or cancel) from waiting on, or ending, the
 * same row twice. Returns the activities it ended.
 */
export async function endDueActivities(q: Queryable, afterSeconds: number, limit: number): Promise<ActivityRow[]> {
  const res = await q.query(
    `WITH due AS (
       SELECT a.id FROM activities a JOIN events e ON e.id = a.event_id
        WHERE e.status = 'PUBLISHED' AND a.ended_at IS NULL
          AND a.ends_at + make_interval(secs => $1) <= now()
        ORDER BY a.ends_at, a.id
        LIMIT $2
        FOR UPDATE OF a SKIP LOCKED
     )
     UPDATE activities a SET ended_at = now(), updated_at = now()
       FROM due WHERE a.id = due.id
     RETURNING a.*`,
    [afterSeconds, limit],
  );
  return res.rows as ActivityRow[];
}
