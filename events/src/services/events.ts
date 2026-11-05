import { randomUUID } from 'node:crypto';
import type { Queryable } from '../db/pool.ts';
import { notFound } from '../errors.ts';
import { EVENT_STATUSES, type Actor, type ActivityRow, type EventRow } from '../domain/model.ts';
import {
  assertCanEnd, assertCanPublish, assertDraft, assertNotCancelled, assertOrganizer, assertOwner, assertValidPeriod,
  assertWithinEvent, canView,
} from '../domain/rules.ts';
import { activityLifecycleMessage, activityMessage, eventMessage } from '../messaging/messages.ts';
import {
  countActivities, deleteActivity, findActivity, insertActivity, listActivities, markEnded, updateActivity,
} from '../repositories/activities.ts';
import { activityBounds, findEvent, insertEvent, listEvents, updateEvent, type EventFilter } from '../repositories/events.ts';
import { createUnitOfWork, type AuthedCtx, type ServiceDeps } from './unit-of-work.ts';
import { toActivityView, toEventView, type ActivityView, type EventView } from './views.ts';

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
  /** Registration fee in minor units (cents of BRL); stored in the `price_cents` column. */
  amount_minor?: number;
  waitlist_enabled?: boolean;
};
/** Capacity is not patchable: it is immutable after creation. */
export type ActivityPatch = Partial<Omit<ActivityInput, 'capacity'>>;

export type EventWithActivities = EventView & { activities: ActivityView[] };
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

  async function page(filter: EventFilter): Promise<Page<EventView>> {
    const { items, total } = await listEvents(deps.pool, filter);
    return { items: items.map(toEventView), total, limit: filter.limit, offset: filter.offset };
  }

  /** The activity and its event if the viewer may see them, else a 404 (drafts are private to their organizer). */
  async function visibleActivity(viewer: Actor | null, activityId: string) {
    const activity = await findActivity(deps.pool, activityId);
    const event = activity && (await findEvent(deps.pool, activity.event_id));
    if (!activity || !event || !canView(event, viewer)) throw notFound('activity');
    return { event, activity };
  }

  return {
    // ---- Reads (RF04) -------------------------------------------------------------------------

    /** Published events, for everyone. */
    listPublished: (q: ListQuery) => page({ ...q, statuses: ['PUBLISHED'] }),

    /** The caller's own events, in any status. */
    listOwn: (actor: Actor, q: ListQuery) => page({ ...q, statuses: EVENT_STATUSES, organizerId: actor.userId }),

    async getEvent(viewer: Actor | null, eventId: string): Promise<EventWithActivities> {
      const event = await visibleEvent(viewer, eventId);
      const at = now();
      const activities = await listActivities(deps.pool, event.id);
      return { ...toEventView(event), activities: activities.map((a) => toActivityView(event, a, at)) };
    },

    async listEventActivities(viewer: Actor | null, eventId: string): Promise<ActivityView[]> {
      const event = await visibleEvent(viewer, eventId);
      const at = now();
      return (await listActivities(deps.pool, event.id)).map((a) => toActivityView(event, a, at));
    },

    /** Stays consultable after it ended or was cancelled; `lifecycle` says which. */
    async getActivity(viewer: Actor | null, activityId: string): Promise<ActivityView> {
      const { event, activity } = await visibleActivity(viewer, activityId);
      return toActivityView(event, activity, now());
    },

    /** Whether the caller administers the activity (the organizer of its event); Subscription asks this per operation. */
    async getPermissions(actor: Actor, activityId: string): Promise<{ can_manage: boolean }> {
      const { event } = await visibleActivity(actor, activityId);
      return { can_manage: event.organizer_id === actor.userId };
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
        await w.publish(eventMessage('EventCreated', event));
        return toEventView(event);
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
        await w.publish(eventMessage('EventUpdated', updated));
        return toEventView(updated);
      }),

    publishEvent: (ctx: AuthedCtx, eventId: string) =>
      run('EVENT_PUBLISH', ctx, async (w) => {
        w.target.event_id = eventId;
        const event = await lockOwnedEvent(w.tx, ctx.actor, eventId);
        assertCanPublish(event, await countActivities(w.tx, eventId), now());
        const updated = await updateEvent(w.tx, eventId, { status: 'PUBLISHED' });
        await w.publish(eventMessage('EventPublished', updated));
        return toEventView(updated);
      }),

    /**
     * Final. Besides EventCancelled, every activity that had not ended gets an ActivityCancelled (one
     * transaction, so Subscription never sees one without the other); ended ones keep their ended state.
     * Subscription cancels the registrations when it reads these.
     */
    cancelEvent: (ctx: AuthedCtx, eventId: string) =>
      run('EVENT_CANCEL', ctx, async (w) => {
        w.target.event_id = eventId;
        const event = await lockOwnedEvent(w.tx, ctx.actor, eventId);
        assertNotCancelled(event);
        const updated = await updateEvent(w.tx, eventId, { status: 'CANCELLED' });
        await w.publish(eventMessage('EventCancelled', updated));
        // Locked: an automatic end of the same activities running now is waited for (and then seen), not duplicated.
        for (const activity of await listActivities(w.tx, eventId, { forUpdate: true })) {
          if (!activity.ended_at) await w.publish(activityLifecycleMessage('ActivityCancelled', activity));
        }
        return toEventView(updated);
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
          price_cents: input.amount_minor ?? 0,
          waitlist_enabled: input.waitlist_enabled ?? false,
        });
        w.target.activity_id = activity.id;
        await w.publish(activityMessage('ActivityCreated', activity));
        return toActivityView(event, activity, now());
      }),

    updateActivity: (ctx: AuthedCtx, activityId: string, patch: ActivityPatch) =>
      run('ACTIVITY_UPDATE', ctx, async (w) => {
        w.target.activity_id = activityId;
        const { event, activity } = await lockOwnedActivity(w.tx, ctx.actor, activityId);
        w.target.event_id = event.id;
        assertNotCancelled(event);
        if (patch.amount_minor !== undefined && patch.amount_minor !== activity.price_cents) {
          assertDraft(event, 'changing the price');
        }
        const period = mergedPeriod(activity, patch);
        assertValidPeriod(period);
        assertWithinEvent(period, event);
        const { amount_minor, ...rest } = patch;
        const updated = await updateActivity(w.tx, activityId, { ...rest, price_cents: amount_minor });
        await w.publish(activityMessage('ActivityUpdated', updated));
        return toActivityView(event, updated, now());
      }),

    /**
     * Manual end by the organizer, only after the scheduled `ends_at`. Repeating it is a 200 with the current
     * activity and no new message.
     */
    endActivity: (ctx: AuthedCtx, activityId: string) =>
      run('ACTIVITY_END', ctx, async (w) => {
        w.target.activity_id = activityId;
        const { event, activity } = await lockOwnedActivity(w.tx, ctx.actor, activityId);
        w.target.event_id = event.id;
        const at = now();
        assertCanEnd(event, activity, at);
        if (activity.ended_at) return toActivityView(event, activity, at);
        const ended = await markEnded(w.tx, activityId, at);
        await w.publish(activityLifecycleMessage('ActivityEnded', ended));
        return toActivityView(event, ended, at);
      }),

    deleteActivity: (ctx: AuthedCtx, activityId: string) =>
      run('ACTIVITY_DELETE', ctx, async (w) => {
        w.target.activity_id = activityId;
        const { event, activity } = await lockOwnedActivity(w.tx, ctx.actor, activityId);
        w.target.event_id = event.id;
        assertDraft(event, 'removing an activity');
        await deleteActivity(w.tx, activityId);
        await w.publish(activityMessage('ActivityDeleted', activity));
      }),
  };
}

export type EventService = ReturnType<typeof createEventService>;
