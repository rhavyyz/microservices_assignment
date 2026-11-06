import type { Pool, PoolClient } from 'pg';
import type { Change, Parsed } from './contracts.ts';

// The read model stores the latest STATE of each entity, never counters. Duplicates are cut by
// processed_messages; out-of-order messages are cut by the `last_event_at` guard. Reports are
// computed from this state at query time, so replays and reordering cannot corrupt a total.

async function applyChange(c: PoolClient, change: Change, at: string): Promise<void> {
  switch (change.kind) {
    case 'event':
      await c.query(
        `INSERT INTO events (event_id, organizer_id, name, status, starts_at, ends_at, last_event_at)
         VALUES ($1, $2, $3, COALESCE($4::text, 'DRAFT'), $5, $6, $7)
         ON CONFLICT (event_id) DO UPDATE SET
           organizer_id  = COALESCE(EXCLUDED.organizer_id, events.organizer_id),
           name          = COALESCE(EXCLUDED.name, events.name),
           status        = COALESCE($4::text, events.status),
           starts_at     = COALESCE(EXCLUDED.starts_at, events.starts_at),
           ends_at       = COALESCE(EXCLUDED.ends_at, events.ends_at),
           last_event_at = EXCLUDED.last_event_at
         WHERE events.last_event_at <= EXCLUDED.last_event_at`,
        [change.eventId, change.organizerId, change.name, change.status, change.startsAt, change.endsAt, at],
      );
      return;
    case 'activity':
      await c.query(
        `INSERT INTO activities (activity_id, event_id, name, capacity, paid, last_event_at)
         VALUES ($1, $2, $3, $4, COALESCE($5::boolean, false), $6)
         ON CONFLICT (activity_id) DO UPDATE SET
           event_id      = EXCLUDED.event_id,
           name          = COALESCE(EXCLUDED.name, activities.name),
           capacity      = COALESCE(EXCLUDED.capacity, activities.capacity),
           paid          = COALESCE($5::boolean, activities.paid),
           last_event_at = EXCLUDED.last_event_at
         WHERE activities.last_event_at <= EXCLUDED.last_event_at`,
        [change.activityId, change.eventId, change.name, change.capacity, change.paid, at],
      );
      return;
    case 'registration':
      await c.query(
        `INSERT INTO registrations (registration_id, event_id, activity_id, user_id, status, last_event_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (registration_id) DO UPDATE SET
           status        = EXCLUDED.status,
           user_id       = COALESCE(EXCLUDED.user_id, registrations.user_id),
           last_event_at = EXCLUDED.last_event_at
         WHERE registrations.last_event_at <= EXCLUDED.last_event_at`,
        [change.registrationId, change.eventId, change.activityId, change.userId, change.status, at],
      );
      return;
    case 'payment':
      await c.query(
        `INSERT INTO payments (payment_id, registration_id, event_id, activity_id, amount_minor, currency, status, last_event_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (payment_id) DO UPDATE SET
           registration_id = COALESCE(EXCLUDED.registration_id, payments.registration_id),
           activity_id     = COALESCE(EXCLUDED.activity_id, payments.activity_id),
           amount_minor    = COALESCE(EXCLUDED.amount_minor, payments.amount_minor),
           currency        = COALESCE(EXCLUDED.currency, payments.currency),
           status          = EXCLUDED.status,
           last_event_at   = EXCLUDED.last_event_at
         WHERE payments.last_event_at <= EXCLUDED.last_event_at`,
        [change.paymentId, change.registrationId, change.eventId, change.activityId, change.amountMinor, change.currency, change.status, at],
      );
      return;
    case 'checkin':
      // One check-in per registration (RF09): a repeat is ignored.
      await c.query(
        `INSERT INTO checkins (registration_id, event_id, activity_id, user_id, checked_at)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (registration_id) DO NOTHING`,
        [change.registrationId, change.eventId, change.activityId, change.userId, at],
      );
      return;
    case 'ignored':
      return;
  }
}

/** Idempotent consumer: the message id and its effect are committed in the same transaction. */
export async function processMessage(pool: Pool, p: Parsed): Promise<'applied' | 'duplicate'> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const seen = await client.query(
      'INSERT INTO processed_messages (message_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [p.envelope.message_id],
    );
    if (seen.rowCount === 0) {
      await client.query('COMMIT');
      return 'duplicate';
    }
    await applyChange(client, p.change, p.envelope.occurred_at);
    await client.query('COMMIT');
    return 'applied';
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
