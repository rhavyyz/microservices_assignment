import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/pool.ts';
import { notFound } from '../errors.ts';
import { EVENT_STATUSES, type Actor, type ActivityRow, type EventRow } from '../domain/model.ts';
import {
  assertCanPublish, assertDraft, assertNotCancelled, assertOrganizer, assertOwner, assertValidPeriod,
  assertWithinEvent, canView,
} from '../domain/rules.ts';
import { activityMessage, eventMessage } from '../messaging/messages.ts';
import {
  countActivities, deleteActivity, findActivity, insertActivity, listActivities, updateActivity,
} from '../repositories/activities.ts';
import { activityBounds, findEvent, insertEvent, listEvents, updateEvent, type EventFilter } from '../repositories/events.ts';
import { createUnitOfWork, type AuthedCtx, type ServiceDeps } from './unit-of-work.ts';

type Optional<T> = T | null | undefined;

export type EventInput = {
  title: string;
  organization?: Optional<string>;
  description?: Optional<string>;
  location?: Optional<string>;
  banner_url?: Optional<string>;
  starts_at: Date;
  ends_at: Date;
};
export type EventPatch = Partial<EventInput>;

export type ActivityInput = {
  title: string;
  description?: Optional<string>;
  speaker?: Optional<string>;
  location?: Optional<string>;
  starts_at: Date;
  ends_at: Date;
  capacity: number;
  price_cents?: number;
  waitlist_enabled?: boolean;
};
/** Capacity is not patchable: it is immutable after creation. */
export type ActivityPatch = Partial<Omit<ActivityInput, 'capacity'>>;

export type EventWithActivities = EventRow & { activities: ActivityRow[] };
export type Page<T> = { items: T[]; total: number; limit: number; offset: number };
export type ListQuery = Omit<EventFilter, 'statuses' | 'organizerId'>;

/** Period after a patch: the patched bounds over the current ones. */
const mergedPeriod = (current: EventRow | ActivityRow, patch: { starts_at?: Date; ends_at?: Date }) => ({
  starts_at: patch.starts_at ?? current.starts_at,
  ends_at: patch.ends_at ?? current.ends_at,
});

export function createEventService(deps: ServiceDeps) {
  const run = createUnitOfWork(deps);
  const now = () => deps.now?.() ?? new Date();

  /** Locks the caller's event for the rest of the transaction; someone else's event is a 404 (RN07). */
  async function lockOwnedEvent(tx: Queryable, actor: Actor, eventId: string): Promise<EventRow> {
    const event = await findEvent(tx, eventId, { forUpdate: true });
    assertOwner(event, actor);
    return event;
  }

  /** Locks the activity and its event (event first, the same order as every other writer). */
  async function lockOwnedActivity(tx: Queryable, actor: Actor, activityId: string) {
    const current = await findActivity(tx, activityId);
    const event = current && (await findEvent(tx, current.event_id, { forUpdate: true }));
    const owned = event !== null && event.organizer_id === actor.userId;
    const activity = owned ? await findActivity(tx, activityId, { forUpdate: true }) : null;
    if (!event || !activity) throw notFound('activity');
    return { event, activity };
  }

  /** The event if the viewer may see it, else a 404 (drafts are private to their organizer). */
  async function visibleEvent(viewer: Actor | null, eventId: string): Promise<EventRow> {
    const event = await findEvent(deps.pool, eventId);
    if (!event || !canView(event, viewer)) throw notFound('event');
    return event;
  }

  async function page(filter: EventFilter): Promise<Page<EventRow>> {
    const { items, total } = await listEvents(deps.pool, filter);
    return { items, total, limit: filter.limit, offset: filter.offset };
  }

  return {
    // ---- Reads (RF04) -------------------------------------------------------------------------

    /** Published events, for everyone. */
    listPublished: (q: ListQuery) => page({ ...q, statuses: ['PUBLISHED'] }),

    /** The caller's own events, in any status. */
    listOwn: (actor: Actor, q: ListQuery) => page({ ...q, statuses: EVENT_STATUSES, organizerId: actor.userId }),

    async getEvent(viewer: Actor | null, eventId: string): Promise<EventWithActivities> {
      const event = await visibleEvent(viewer, eventId);
      return { ...event, activities: await listActivities(deps.pool, event.id) };
    },

    async listEventActivities(viewer: Actor | null, eventId: string): Promise<ActivityRow[]> {
      const event = await visibleEvent(viewer, eventId);
      return listActivities(deps.pool, event.id);
    },

    async getActivity(viewer: Actor | null, activityId: string): Promise<ActivityRow> {
      const activity = await findActivity(deps.pool, activityId);
      const event = activity && (await findEvent(deps.pool, activity.event_id));
      if (!activity || !event || !canView(event, viewer)) throw notFound('activity');
      return activity;
    },

    // ---- Events (RF02) ------------------------------------------------------------------------

    createEvent: (ctx: AuthedCtx, input: EventInput) =>
      run('EVENT_CREATE', ctx, async (w) => {
        assertOrganizer(ctx.actor);
        assertValidPeriod(input);
        const event = await insertEvent(w.tx, {
          id: randomUUID(),
          organizer_id: ctx.actor.userId,
          title: input.title,
          organization: input.organization ?? null,
          description: input.description ?? null,
          location: input.location ?? null,
          banner_url: input.banner_url ?? null,
          starts_at: input.starts_at,
          ends_at: input.ends_at,
        });
        w.target.event_id = event.id;
        await w.publish(eventMessage('event.created', event));
        return event;
      }),

    updateEvent: (ctx: AuthedCtx, eventId: string, patch: EventPatch) =>
      run('EVENT_UPDATE', ctx, async (w) => {
        w.target.event_id = eventId;
        const event = await lockOwnedEvent(w.tx, ctx.actor, eventId);
        assertNotCancelled(event);
        const period = mergedPeriod(event, patch);
        assertValidPeriod(period);
        const bounds = await activityBounds(w.tx, eventId);
        if (bounds) assertWithinEvent(bounds, period);
        const updated = await updateEvent(w.tx, eventId, patch);
        await w.publish(eventMessage('event.updated', updated));
        return updated;
      }),

    publishEvent: (ctx: AuthedCtx, eventId: string) =>
      run('EVENT_PUBLISH', ctx, async (w) => {
        w.target.event_id = eventId;
        const event = await lockOwnedEvent(w.tx, ctx.actor, eventId);
        assertCanPublish(event, await countActivities(w.tx, eventId), now());
        const updated = await updateEvent(w.tx, eventId, { status: 'PUBLISHED' });
        await w.publish(eventMessage('event.published', updated));
        return updated;
      }),

    /** Final. Registrations are cancelled by the subscription service when it reads event.cancelled. */
    cancelEvent: (ctx: AuthedCtx, eventId: string) =>
      run('EVENT_CANCEL', ctx, async (w) => {
        w.target.event_id = eventId;
        const event = await lockOwnedEvent(w.tx, ctx.actor, eventId);
        assertNotCancelled(event);
        const updated = await updateEvent(w.tx, eventId, { status: 'CANCELLED' });
        await w.publish(eventMessage('event.cancelled', updated));
        return updated;
      }),

    // ---- Schedule (RF03) ----------------------------------------------------------------------

    addActivity: (ctx: AuthedCtx, eventId: string, input: ActivityInput) =>
      run('ACTIVITY_CREATE', ctx, async (w) => {
        w.target.event_id = eventId;
        const event = await lockOwnedEvent(w.tx, ctx.actor, eventId);
        assertNotCancelled(event);
        assertValidPeriod(input);
        assertWithinEvent(input, event);
        const activity = await insertActivity(w.tx, {
          id: randomUUID(),
          event_id: eventId,
          title: input.title,
          description: input.description ?? null,
          speaker: input.speaker ?? null,
          location: input.location ?? null,
          starts_at: input.starts_at,
          ends_at: input.ends_at,
          capacity: input.capacity,
          price_cents: input.price_cents ?? 0,
          waitlist_enabled: input.waitlist_enabled ?? false,
        });
        w.target.activity_id = activity.id;
        await w.publish(activityMessage('activity.created', activity));
        return activity;
      }),

    updateActivity: (ctx: AuthedCtx, activityId: string, patch: ActivityPatch) =>
      run('ACTIVITY_UPDATE', ctx, async (w) => {
        w.target.activity_id = activityId;
        const { event, activity } = await lockOwnedActivity(w.tx, ctx.actor, activityId);
        w.target.event_id = event.id;
        assertNotCancelled(event);
        if (patch.price_cents !== undefined && patch.price_cents !== activity.price_cents) {
          assertDraft(event, 'changing the price');
        }
        const period = mergedPeriod(activity, patch);
        assertValidPeriod(period);
        assertWithinEvent(period, event);
        const updated = await updateActivity(w.tx, activityId, patch);
        await w.publish(activityMessage('activity.updated', updated));
        return updated;
      }),

    deleteActivity: (ctx: AuthedCtx, activityId: string) =>
      run('ACTIVITY_DELETE', ctx, async (w) => {
        w.target.activity_id = activityId;
        const { event, activity } = await lockOwnedActivity(w.tx, ctx.actor, activityId);
        w.target.event_id = event.id;
        assertDraft(event, 'removing an activity');
        await deleteActivity(w.tx, activityId);
        await w.publish(activityMessage('activity.deleted', activity));
      }),
  };
}

export type EventService = ReturnType<typeof createEventService>;
