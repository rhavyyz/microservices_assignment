// Business rules of events and their schedule, as pure functions (no I/O), so they are unit tested
// in isolation and shared by every use case that needs them.

import { conflict, forbidden, notFound, unprocessable } from '../errors.ts';
import {
  ORGANIZER_ROLE, PUBLIC_EVENT_STATUSES, type ActivityLifecycle, type ActivityRow, type Actor, type EventRow, type Period,
} from './model.ts';

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

/** An ended activity is read-only: moving its dates after `ActivityEnded` was published would contradict that message. */
export function assertNotEnded(activity: Pick<ActivityRow, 'ended_at'>): void {
  if (activity.ended_at) throw conflict('ACTIVITY_ENDED', 'the activity has ended and can no longer be edited');
}

/**
 * Changes that would invalidate existing registrations or pending payments (removing an activity,
 * changing its price) are allowed only before the event is published, when no registration can exist yet.
 */
export function assertDraft(event: EventRow, what: string): void {
  if (event.status !== 'DRAFT') throw conflict('EVENT_NOT_DRAFT', `${what} is only allowed while the event is a draft`);
}

export function assertCanPublish(event: EventRow, activityCount: number, now: Date): void {
  if (event.status !== 'DRAFT') throw conflict('INVALID_STATUS', `cannot publish an event that is ${event.status}`);
  if (activityCount === 0) throw conflict('EVENT_WITHOUT_ACTIVITIES', 'add at least one activity before publishing');
  if (event.ends_at <= now) throw conflict('EVENT_ENDED', 'cannot publish an event that already ended');
}

/** CANCELLED if the event is cancelled, else ENDED once `ended_at` is set, else OPEN. */
export function activityLifecycle(event: Pick<EventRow, 'status'>, activity: Pick<ActivityRow, 'ended_at'>): ActivityLifecycle {
  if (event.status === 'CANCELLED') return 'CANCELLED';
  return activity.ended_at ? 'ENDED' : 'OPEN';
}

/** Registration is open while the event is published, the activity is neither ended nor cancelled and it has not started. */
export function isRegistrationOpen(event: EventRow, activity: ActivityRow, now: Date): boolean {
  return event.status === 'PUBLISHED' && activityLifecycle(event, activity) === 'OPEN' && now < activity.starts_at;
}

/**
 * Manual end by the organizer. Only published events have running activities; an already ended activity is
 * left alone by the caller (idempotent). Subscription refuses an ActivityEnded before the scheduled end and
 * would stall its consumer on it, so it is never emitted early.
 */
export function assertCanEnd(event: EventRow, activity: ActivityRow, now: Date): void {
  if (event.status !== 'PUBLISHED') throw conflict('EVENT_NOT_OPEN', `cannot end an activity of an event that is ${event.status}`);
  if (activity.ended_at) return;
  if (now < activity.ends_at) throw conflict('ACTIVITY_NOT_ENDED', 'the activity has not reached its scheduled end yet');
}
