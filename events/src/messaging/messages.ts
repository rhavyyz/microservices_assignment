// Messages this service publishes on the events topic (default `events-events`). See README.md.
// One mapper per entity, so created/updated/published/cancelled always carry the same fields.

import { CURRENCY, type ActivityRow, type EventRow } from '../domain/model.ts';
import type { SeatRejection } from '../domain/rules.ts';

export type EventMessageType = 'event.created' | 'event.updated' | 'event.published' | 'event.cancelled';
export type ActivityMessageType = 'activity.created' | 'activity.updated' | 'activity.deleted';
export type SeatMessageType = 'seat.reserved' | 'seat.rejected' | 'seat.released';

/** A message before it gets its envelope: type, partition key and data. */
export type Outgoing = { type: string; key: string; data: Record<string, unknown> };

// `name` (not `title`) is the field the reports service reads.
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
      available: a.available,
      price_cents: a.price_cents,
      currency: CURRENCY,
      paid: a.paid,
      waitlist_enabled: a.waitlist_enabled,
    },
  };
}

export type SeatRef = { registration_id: string; event_id: string; activity_id: string; user_id: string | null };

// Keyed by registration_id: the subscription service sees the answers about one registration in order.
function seatMessage(type: SeatMessageType, ref: SeatRef, extra: Record<string, unknown>): Outgoing {
  return { type, key: ref.registration_id, data: { ...ref, ...extra } };
}

/** The seat is held. Carries the price so the subscription service knows whether to start a payment (RN02). */
export function seatReserved(ref: SeatRef, a: ActivityRow): Outgoing {
  return seatMessage('seat.reserved', ref, {
    price_cents: a.price_cents, currency: CURRENCY, paid: a.paid, available: a.available,
  });
}

/** No seat. `waitlist_enabled` tells the subscription service whether to put the registration on the waitlist. */
export function seatRejected(ref: SeatRef, reason: SeatRejection, a: ActivityRow | null): Outgoing {
  return seatMessage('seat.rejected', ref, { reason, waitlist_enabled: a?.waitlist_enabled ?? false });
}

/** A seat was freed (RN03/RN04): the subscription service may offer it to the next one on the waitlist. */
export function seatReleased(ref: SeatRef, a: ActivityRow): Outgoing {
  return seatMessage('seat.released', ref, { available: a.available, waitlist_enabled: a.waitlist_enabled });
}
