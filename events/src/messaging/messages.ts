// Messages this service publishes on the events topic (default `events.events`). See docs/contracts.md.
// One mapper per entity, so created/updated/published/cancelled always carry the same fields.

import { CURRENCY, type ActivityRow, type EventRow } from '../domain/model.ts';

export type EventMessageType = 'EventCreated' | 'EventUpdated' | 'EventPublished' | 'EventCancelled';
export type ActivityMessageType = 'ActivityCreated' | 'ActivityUpdated' | 'ActivityDeleted';
export type ActivityLifecycleMessageType = 'ActivityEnded' | 'ActivityCancelled';

/** A message before it gets its envelope: type, partition key and the fields that sit next to the envelope's. */
export type Outgoing = { type: string; key: string; data: Record<string, unknown> };

// `name` (not `title`) is the field the consumers read.
export function eventMessage(type: EventMessageType, e: EventRow): Outgoing {
  return {
    type,
    key: e.id,
    data: {
      event_id: e.id,
      organizer_id: e.organizer_id,
      organization: e.organization,
      name: e.title,
      status: e.status,
      starts_at: e.starts_at.toISOString(),
      ends_at: e.ends_at.toISOString(),
    },
  };
}

// Keyed by event_id like the event messages, so an event's schedule changes stay ordered after its creation.
export function activityMessage(type: ActivityMessageType, a: ActivityRow): Outgoing {
  return {
    type,
    key: a.event_id,
    data: {
      activity_id: a.id,
      event_id: a.event_id,
      name: a.title,
      starts_at: a.starts_at.toISOString(),
      ends_at: a.ends_at.toISOString(),
      capacity: a.capacity,
      amount_minor: a.price_cents,
      currency: CURRENCY,
      paid: a.paid,
      waitlist_enabled: a.waitlist_enabled,
    },
  };
}

// Keyed by activity_id: Subscription applies the end or cancellation of one activity in order.
export function activityLifecycleMessage(type: ActivityLifecycleMessageType, a: ActivityRow): Outgoing {
  return {
    type,
    key: a.id,
    data: { activity_id: a.id, event_id: a.event_id, ends_at: a.ends_at.toISOString() },
  };
}
