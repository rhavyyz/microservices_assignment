import type { Queryable } from '../db/pool.ts';
import { insertRow, lockClause, updateColumns } from '../db/sql.ts';
import type { EventRow, EventStatus } from '../domain/model.ts';

/** Columns an organizer can edit (status changes go through publish/cancel). */
export const EDITABLE_EVENT_COLUMNS = [
  'title', 'organization', 'description', 'location', 'banner_url', 'starts_at', 'ends_at',
] as const;

export type NewEvent = Pick<EventRow, 'id' | 'organizer_id' | (typeof EDITABLE_EVENT_COLUMNS)[number]>;

export type EventFilter = {
  statuses: readonly EventStatus[];
  organizerId?: string;
  /** Case-insensitive match on title, description, organization or location. */
  text?: string;
  /** Events that end at or after this instant. */
  from?: Date;
  /** Events that start at or before this instant. */
  to?: Date;
  limit: number;
  offset: number;
};

export function insertEvent(q: Queryable, e: NewEvent): Promise<EventRow> {
  return insertRow<EventRow>(q, 'events', e);
}

export async function findEvent(q: Queryable, id: string, opts: { forUpdate?: boolean } = {}): Promise<EventRow | null> {
  const res = await q.query(`SELECT * FROM events WHERE id = $1${lockClause(opts.forUpdate)}`, [id]);
  return (res.rows[0] as EventRow | undefined) ?? null;
}

export function updateEvent(q: Queryable, id: string, patch: Partial<EventRow>): Promise<EventRow> {
  return updateColumns<EventRow>(q, 'events', id, patch, [...EDITABLE_EVENT_COLUMNS, 'status']);
}

export async function listEvents(q: Queryable, f: EventFilter): Promise<{ items: EventRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: (p: string) => string, value: unknown) => {
    params.push(value);
    where.push(sql(`$${params.length}`));
  };

  add((p) => `status = ANY(${p}::text[])`, f.statuses);
  if (f.organizerId) add((p) => `organizer_id = ${p}`, f.organizerId);
  if (f.text) {
    add((p) => `(title ILIKE ${p} OR description ILIKE ${p} OR organization ILIKE ${p} OR location ILIKE ${p})`,
      `%${f.text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (f.from) add((p) => `ends_at >= ${p}`, f.from);
  if (f.to) add((p) => `starts_at <= ${p}`, f.to);

  const condition = where.join(' AND ');
  const [page, count] = await Promise.all([
    q.query(
      `SELECT * FROM events WHERE ${condition} ORDER BY starts_at, id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, f.offset],
    ),
    q.query(`SELECT count(*)::int AS total FROM events WHERE ${condition}`, params),
  ]);
  return { items: page.rows as EventRow[], total: (count.rows[0] as { total: number }).total };
}

/** Earliest start and latest end of the event's activities (null when it has none). */
export async function activityBounds(q: Queryable, eventId: string): Promise<{ starts_at: Date; ends_at: Date } | null> {
  const res = await q.query(
    'SELECT min(starts_at) AS starts_at, max(ends_at) AS ends_at FROM activities WHERE event_id = $1',
    [eventId],
  );
  const row = res.rows[0] as { starts_at: Date | null; ends_at: Date | null };
  return row.starts_at && row.ends_at ? { starts_at: row.starts_at, ends_at: row.ends_at } : null;
}
