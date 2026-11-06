// Entities owned by the events service, as stored (snake_case database columns). The HTTP API and the
// Kafka messages use Subscription's names (event_id, activity_id, amount_minor): see services/views.ts
// and messaging/messages.ts. The service only keeps the maximum capacity; Subscription counts the seats.

export const EVENT_STATUSES = ['DRAFT', 'PUBLISHED', 'CANCELLED'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Statuses anyone may see; DRAFT events are visible to their organizer only. */
export const PUBLIC_EVENT_STATUSES: readonly EventStatus[] = ['PUBLISHED', 'CANCELLED'];

/** All registration fees are in this currency (amounts are integers in minor units, cents). */
export const CURRENCY = 'BRL';

export type EventRow = {
  id: string;
  organizer_id: string;
  organization: string | null;
  title: string;
  description: string | null;
  location: string | null;
  banner_url: string | null;
  starts_at: Date;
  ends_at: Date;
  status: EventStatus;
  created_at: Date;
  updated_at: Date;
};

/** An item of the event's schedule (programação). It is the unit of registration, capacity and price. */
export type ActivityRow = {
  id: string;
  event_id: string;
  title: string;
  description: string | null;
  speaker: string | null;
  location: string | null;
  starts_at: Date;
  ends_at: Date;
  /** Immutable after creation (design decision; enforced by a database trigger too). */
  capacity: number;
  /** Stored in cents of BRL; exposed as `amount_minor` by the API and the messages. */
  price_cents: number;
  /** Generated column: price_cents > 0. */
  paid: boolean;
  waitlist_enabled: boolean;
  /** When the activity ended (manually after `ends_at`, or automatically); null while it has not. */
  ended_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

/** Derived from the event status and `ended_at`; never stored. */
export const ACTIVITY_LIFECYCLES = ['OPEN', 'ENDED', 'CANCELLED'] as const;
export type ActivityLifecycle = (typeof ACTIVITY_LIFECYCLES)[number];

export type Period = { starts_at: Date; ends_at: Date };

export type Actor = { userId: string; roles: string[] };

export const ORGANIZER_ROLE = 'ORGANIZER';
