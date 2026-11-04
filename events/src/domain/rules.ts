// Business rules of events and their schedule, as pure functions (no I/O), so they are unit tested
// in isolation and shared by every use case that needs them.

import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import { ORGANIZER_ROLE, PUBLIC_EVENT_STATUSES, type ActivityRow, type Actor, type EventRow, type Period } from './model.ts';

export function assertOrganizer(actor: Actor): void {
  if (!actor.roles.includes(ORGANIZER_ROLE)) throw forbidden('only organizers can create events');
}

/**
 * RN07: organizers administer only their own events. A missing event and someone else's event give the
 * same 404, so the existence of other organizers' events never leaks.
 */
export function assertOwner(event: EventRow | null, actor: Actor): asserts event is EventRow {
  if (!event || event.organizer_id !== actor.userId) throw notFound('event');
}

/** DRAFT events exist only for their organizer; everyone else gets a 404. */
export function canView(event: EventRow, viewer: Actor | null): boolean {
  return PUBLIC_EVENT_STATUSES.includes(event.status) || event.organizer_id === viewer?.userId;
}

export function assertValidPeriod(p: Period): void {
  if (p.ends_at.getTime() <= p.starts_at.getTime()) {
    throw unprocessable('INVALID_PERIOD', 'ends_at must be after starts_at');
  }
}

export function assertWithinEvent(activity: Period, event: Period): void {
  if (activity.starts_at < event.starts_at || activity.ends_at > event.ends_at) {
    throw unprocessable('ACTIVITY_OUTSIDE_EVENT', 'activities must happen within the event period');
  }
}

/** Cancelled is a final state: nothing about the event or its schedule changes afterwards. */
export function assertNotCancelled(event: EventRow): void {
  if (event.status === 'CANCELLED') throw conflict('EVENT_CANCELLED', 'the event is cancelled');
}

/**
 * Changes that would invalidate existing registrations or pending payments (removing an activity,
 * changing its price) are allowed only before the event is published, when no seat can be held yet.
 */
export function assertDraft(event: EventRow, what: string): void {
  if (event.status !== 'DRAFT') throw conflict('EVENT_NOT_DRAFT', `${what} is only allowed while the event is a draft`);
}

export function assertCanPublish(event: EventRow, activityCount: number, now: Date): void {
  if (event.status !== 'DRAFT') throw conflict('INVALID_STATUS', `cannot publish an event that is ${event.status}`);
  if (activityCount === 0) throw conflict('EVENT_WITHOUT_ACTIVITIES', 'add at least one activity before publishing');
  if (event.ends_at <= now) throw conflict('EVENT_ENDED', 'cannot publish an event that already ended');
}

export type SeatRejection = 'ACTIVITY_NOT_FOUND' | 'EVENT_NOT_OPEN' | 'REGISTRATION_CLOSED' | 'FULL';

/**
 * Why a seat cannot be reserved. The reservation itself is a single conditional UPDATE in the database
 * (the only place that is safe under concurrency); this explains a refusal after that UPDATE matched nothing.
 */
export function seatRejection(
  found: { event: EventRow; activity: ActivityRow } | null,
  eventId: string,
  now: Date,
): SeatRejection {
  if (!found || found.activity.event_id !== eventId) return 'ACTIVITY_NOT_FOUND';
  if (found.event.status !== 'PUBLISHED') return 'EVENT_NOT_OPEN';
  if (found.activity.starts_at <= now) return 'REGISTRATION_CLOSED';
  return 'FULL';
}
