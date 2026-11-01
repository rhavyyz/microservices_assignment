// Entities owned by the events service. Fields use the same snake_case names as the database columns,
// the HTTP API and the Kafka messages, so rows travel through the layers without mapping code.

export const EVENT_STATUSES = ['DRAFT', 'PUBLISHED', 'CANCELLED'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];

/** Statuses anyone may see; DRAFT events are visible to their organizer only. */
export const PUBLIC_EVENT_STATUSES: readonly EventStatus[] = ['PUBLISHED', 'CANCELLED'];

/** All registration fees are in this currency (prices are integers in cents). */
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
  /** Seats held by registrations (pending payment or confirmed). Never above capacity (RN01). */
  reserved: number;
  /** Generated column: capacity - reserved. */
  available: number;
  price_cents: number;
  /** Generated column: price_cents > 0. */
  paid: boolean;
  waitlist_enabled: boolean;
  created_at: Date;
  updated_at: Date;
};

export type ReservationRow = {
  registration_id: string;
  activity_id: string;
  event_id: string;
  user_id: string | null;
  status: 'HELD' | 'RELEASED';
  created_at: Date;
  updated_at: Date;
};

export type Period = { starts_at: Date; ends_at: Date };

export type Actor = { userId: string; roles: string[] };

export const ORGANIZER_ROLE = 'ORGANIZER';
