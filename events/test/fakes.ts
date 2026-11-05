// In-memory stand-in for the PostgreSQL pool, for tests with no database. It understands exactly the SQL the
// repositories send (anything else throws, so a new query cannot go unnoticed) and rolls back on ROLLBACK.
// It cannot prove the SQL itself is right: that is what test/integration is for.
import type pg from 'pg';
import type { Audit, AuditEntry } from '../src/audit.ts';
import type { ActivityRow, EventRow } from '../src/domain/model.ts';
import type { Envelope } from '../src/messaging/envelope.ts';
import { createEventService, type EventService } from '../src/services/events.ts';

type Row = Record<string, unknown>;
type OutboxRow = { topic: string; key: string; envelope: Envelope };

export const d = (s: string) => new Date(s);

export function fakeDb(clock: { now: Date }) {
  let events = new Map<string, Row>();
  let activities = new Map<string, Row>();
  let outbox: OutboxRow[] = [];
  let snapshot: { events: Map<string, Row>; activities: Map<string, Row>; outbox: OutboxRow[] } | null = null;
  const clone = (m: Map<string, Row>) => new Map([...m].map(([k, v]) => [k, { ...v }]));
  /** Activity ids another transaction holds a row lock on (FOR UPDATE SKIP LOCKED skips them). */
  const locked = new Set<string>();

  /** Tests can hold every query until `gate` resolves, and make connecting fail, to exercise slow and failing runs. */
  const control: { gate: Promise<void> | null; connectError: Error | null } = { gate: null, connectError: null };

  async function query(text: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number }> {
    if (control.gate) await control.gate;
    const sql = text.replace(/\s+/g, ' ').trim();
    const rows = (r: Row[]) => ({ rows: r.map((x) => ({ ...x })), rowCount: r.length });
    const byStart = (a: Row, b: Row) => (a.starts_at as Date).getTime() - (b.starts_at as Date).getTime();

    if (sql === 'BEGIN') { snapshot = { events: clone(events), activities: clone(activities), outbox: [...outbox] }; return rows([]); }
    if (sql === 'COMMIT') { snapshot = null; return rows([]); }
    if (sql === 'ROLLBACK') {
      if (snapshot) ({ events, activities, outbox } = snapshot);
      snapshot = null;
      return rows([]);
    }

    let m: RegExpExecArray | null;
    if (/^SELECT \* FROM events WHERE id = \$1/.test(sql)) return rows([events.get(params[0] as string)].filter(Boolean) as Row[]);
    if (/^SELECT \* FROM activities WHERE id = \$1/.test(sql)) return rows([activities.get(params[0] as string)].filter(Boolean) as Row[]);
    if (/^SELECT \* FROM activities WHERE event_id = \$1 ORDER BY starts_at, id/.test(sql)) {
      return rows([...activities.values()].filter((a) => a.event_id === params[0]).sort(byStart));
    }
    if (/^SELECT count\(\*\)::int AS n FROM activities WHERE event_id = \$1/.test(sql)) {
      return { rows: [{ n: [...activities.values()].filter((a) => a.event_id === params[0]).length }], rowCount: 1 };
    }
    if (/^SELECT \* FROM events WHERE status = ANY/.test(sql)) { // text, period filters and paging are not simulated
      const mine = sql.includes('organizer_id = $2') ? params[1] : null;
      const found = [...events.values()].filter((e) => (params[0] as string[]).includes(e.status as string) && (!mine || e.organizer_id === mine));
      return rows(found.sort(byStart));
    }
    if (/^SELECT count\(\*\)::int AS total FROM events WHERE status = ANY/.test(sql)) {
      const mine = sql.includes('organizer_id = $2') ? params[1] : null;
      const n = [...events.values()].filter((e) => (params[0] as string[]).includes(e.status as string) && (!mine || e.organizer_id === mine)).length;
      return { rows: [{ total: n }], rowCount: 1 };
    }
    if ((m = /^INSERT INTO (events|activities) \(([^)]*)\) VALUES/.exec(sql))) {
      const keys = m[2].split(',').map((k) => k.trim());
      const row: Row = Object.fromEntries(keys.map((k, i) => [k, params[i]]));
      const stamp = { created_at: clock.now, updated_at: clock.now };
      if (m[1] === 'events') {
        row.status = 'DRAFT';
        events.set(row.id as string, { ...row, ...stamp });
        return rows([events.get(row.id as string)!]);
      }
      activities.set(row.id as string, { price_cents: 0, waitlist_enabled: false, ...row, paid: ((row.price_cents as number) ?? 0) > 0, ended_at: null, ...stamp });
      return rows([activities.get(row.id as string)!]);
    }
    if ((m = /^UPDATE (events|activities) SET (.*) WHERE id = \$(\d+) RETURNING \*/.exec(sql))) {
      const table = m[1] === 'events' ? events : activities;
      const row = table.get(params[Number(m[3]) - 1] as string);
      if (!row) return rows([]);
      for (const part of m[2].split(', ')) {
        const [col, value] = part.split(' = ');
        if (value === 'now()') row[col] = clock.now;
        else row[col] = params[Number(value.slice(1)) - 1];
      }
      if (m[1] === 'activities') row.paid = (row.price_cents as number) > 0;
      return rows([row]);
    }
    if (/^DELETE FROM activities WHERE id = \$1/.test(sql)) {
      return { rows: [], rowCount: activities.delete(params[0] as string) ? 1 : 0 };
    }
    if (/^INSERT INTO outbox/.test(sql)) {
      outbox.push({ topic: params[1] as string, key: params[2] as string, envelope: JSON.parse(params[3] as string) as Envelope });
      return { rows: [], rowCount: 1 };
    }
    if (/^WITH due AS/.test(sql)) {
      const [afterSeconds, limit] = params as [number, number];
      const due = [...activities.values()]
        .filter((a) => !locked.has(a.id as string) && a.ended_at === null && events.get(a.event_id as string)?.status === 'PUBLISHED'
          && (a.ends_at as Date).getTime() + afterSeconds * 1000 <= clock.now.getTime())
        .sort((a, b) => (a.ends_at as Date).getTime() - (b.ends_at as Date).getTime() || String(a.id).localeCompare(String(b.id)))
        .slice(0, limit);
      for (const a of due) { a.ended_at = clock.now; a.updated_at = clock.now; }
      return rows(due);
    }
    throw new Error(`fake db: unsupported SQL: ${sql}`);
  }

  const client = { query, release: () => {} };
  const pool = {
    query,
    connect: async () => {
      if (control.connectError) throw control.connectError;
      return client;
    },
  } as unknown as pg.Pool;
  return {
    pool,
    control,
    locked,
    outbox: (): (Envelope & { key: string; topic: string })[] => outbox.map((o) => ({ ...o.envelope, key: o.key, topic: o.topic })),
    clearOutbox: () => { outbox = []; },
    activity: (id: string) => activities.get(id) as unknown as ActivityRow,
    seedEvent: (o: Partial<EventRow> = {}): EventRow => {
      const e = {
        id: 'e1', organizer_id: ORGANIZER_ID, organization: null, title: 'Conf', description: null, location: null, banner_url: null,
        starts_at: d('2030-05-01T08:00:00Z'), ends_at: d('2030-05-03T18:00:00Z'), status: 'PUBLISHED',
        created_at: d('2026-01-01T00:00:00Z'), updated_at: d('2026-01-01T00:00:00Z'), ...o,
      } as EventRow;
      events.set(e.id, { ...e });
      return e;
    },
    seedActivity: (o: Partial<ActivityRow> = {}): ActivityRow => {
      const a = {
        id: 'a1', event_id: 'e1', title: 'Talk', description: null, speaker: null, location: null,
        starts_at: d('2030-05-01T09:00:00Z'), ends_at: d('2030-05-01T10:00:00Z'), capacity: 30, price_cents: 5000, paid: true,
        waitlist_enabled: true, ended_at: null, created_at: d('2026-01-01T00:00:00Z'), updated_at: d('2026-01-01T00:00:00Z'), ...o,
      } as ActivityRow;
      activities.set(a.id, { ...a });
      return a;
    },
  };
}

export type FakeDb = ReturnType<typeof fakeDb>;

export const ORGANIZER_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_ID = '22222222-2222-4222-8222-222222222222';

export const organizer = { actor: { userId: ORGANIZER_ID, roles: ['ORGANIZER'] }, traceId: 'trace-1234' };
export const other = { actor: { userId: OTHER_ID, roles: ['ORGANIZER'] }, traceId: 'trace-5678' };

/** The real event service over the fake database, with an audit sink and a controllable clock. */
export function fakeService(now = d('2030-05-01T11:00:00Z')) {
  const clock = { now };
  const db = fakeDb(clock);
  const audits: AuditEntry[] = [];
  const audit: Audit = (e) => void audits.push(e);
  const deps = { pool: db.pool, topic: 'events.events', audit, now: () => clock.now };
  const events: EventService = createEventService(deps);
  return { db, clock, audits, deps, events };
}
