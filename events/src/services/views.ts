// The HTTP representation of events and activities (Subscription's names: event_id, activity_id,
// amount_minor). The database rows keep their column names; this is the boundary where they are mapped.
import { CURRENCY, type ActivityLifecycle, type ActivityRow, type EventRow } from '../domain/model.ts';
import { activityLifecycle, isRegistrationOpen } from '../domain/rules.ts';

export type EventView = Omit<EventRow, 'id'> & { event_id: string };

export type ActivityView = Omit<ActivityRow, 'id' | 'price_cents'> & {
  activity_id: string;
  amount_minor: number;
  currency: typeof CURRENCY;
  registration_open: boolean;
  lifecycle: ActivityLifecycle;
};

export function toEventView(e: EventRow): EventView {
  const { id, ...rest } = e;
  return { event_id: id, ...rest };
}

export function toActivityView(event: EventRow, a: ActivityRow, now: Date): ActivityView {
  // SELECT a.* still returns the legacy `reserved` / `available` columns (kept in the schema, unused);
  // they are dropped here so they never leave the service.
  const { id, price_cents, reserved: _reserved, available: _available, ...rest } =
    a as ActivityRow & { reserved?: unknown; available?: unknown };
  return {
    activity_id: id,
    ...rest,
    amount_minor: price_cents,
    currency: CURRENCY,
    registration_open: isRegistrationOpen(event, a, now),
    lifecycle: activityLifecycle(event, a),
  };
}
