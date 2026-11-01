// Shared setup of the integration tests: a real PostgreSQL (TEST_DATABASE_URL), the real services,
// and an in-memory audit sink. Without TEST_DATABASE_URL every integration test is skipped.
import type pg from 'pg';
import type { AuditEntry } from '../../src/audit.ts';
import { createPool, migrate } from '../../src/db/pool.ts';
import type { Envelope } from '../../src/messaging/envelope.ts';
import { createEventService, type ActivityInput, type EventInput, type EventService } from '../../src/services/events.ts';
import type { AuthedCtx } from '../../src/services/unit-of-work.ts';

export const databaseUrl = process.env.TEST_DATABASE_URL;
export const skip = databaseUrl ? false : 'set TEST_DATABASE_URL to run the integration tests';

export const TOPIC = 'events-events';

export async function setup() {
  const pool: pg.Pool = createPool(databaseUrl!);
  await migrate(pool);
  const audits: AuditEntry[] = [];
  const deps = { pool, topic: TOPIC, audit: (e: AuditEntry) => void audits.push(e) };
  return { pool, audits, events: createEventService(deps) };
}

export async function reset(pool: pg.Pool): Promise<void> {
  await pool.query('TRUNCATE outbox, processed_messages, seat_reservations, activities, events');
}

/** Messages waiting in the outbox, oldest first. */
export async function outbox(pool: pg.Pool): Promise<(Envelope & { key: string; topic: string })[]> {
  const res = await pool.query('SELECT topic, message_key, payload FROM outbox ORDER BY seq');
  return res.rows.map((r) => ({ ...(r.payload as Envelope), key: r.message_key as string, topic: r.topic as string }));
}

export const ctx = (userId: string, roles = ['ORGANIZER']): AuthedCtx => ({ actor: { userId, roles }, correlationId: 'corr-1' });
export const organizer = ctx('organizer-1');
export const otherOrganizer = ctx('organizer-2');

const day = 24 * 3600 * 1000;
/** A future event (in a week, three days long) so it can be published and booked. */
export function eventInput(overrides: Partial<EventInput> = {}): EventInput {
  const starts = new Date(Date.now() + 7 * day);
  return { title: 'Semana de Computação', starts_at: starts, ends_at: new Date(starts.getTime() + 3 * day), ...overrides };
}

export function activityInput(event: { starts_at: Date }, overrides: Partial<ActivityInput> = {}): ActivityInput {
  const starts = new Date(event.starts_at.getTime() + 3600 * 1000);
  return { title: 'Minicurso de Kafka', starts_at: starts, ends_at: new Date(starts.getTime() + 2 * 3600 * 1000), capacity: 10, ...overrides };
}

/** A published event with one activity of the given capacity/price, ready to take reservations. */
export async function openActivity(events: EventService, activity: Partial<ActivityInput> = {}) {
  const event = await events.createEvent(organizer, eventInput());
  const created = await events.addActivity(organizer, event.id, activityInput(event, activity));
  await events.publishEvent(organizer, event.id);
  return { event, activity: created };
}
