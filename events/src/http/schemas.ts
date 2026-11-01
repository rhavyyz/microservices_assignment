// JSON schemas of the HTTP API. Fastify validates requests against them, serializes responses with them
// (only the listed fields go out) and @fastify/swagger turns them into /openapi.json.
import { EVENT_STATUSES } from '../domain/model.ts';

const text = (maxLength: number) => ({ type: 'string', minLength: 1, maxLength, pattern: '\\S' }) as const;
const optionalText = (maxLength: number) => ({ type: ['string', 'null'], maxLength }) as const;
const dateTime = { type: 'string', format: 'date-time' } as const;
const uuid = { type: 'string', format: 'uuid' } as const;
const nullable = <T extends { type: string }>(s: T) => ({ ...s, type: [s.type, 'null'] });

const object = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ type: 'object', additionalProperties: false, properties, ...extra }) as const;

// ---- Requests -----------------------------------------------------------------------------------

const eventFields = {
  title: text(200),
  organization: optionalText(200),
  description: optionalText(5000),
  location: optionalText(300),
  banner_url: { type: ['string', 'null'], format: 'uri', maxLength: 2000 },
  starts_at: dateTime,
  ends_at: dateTime,
};

const activityFields = {
  title: text(200),
  description: optionalText(5000),
  speaker: optionalText(200),
  location: optionalText(300),
  starts_at: dateTime,
  ends_at: dateTime,
  price_cents: { type: 'integer', minimum: 0, maximum: 100_000_000, description: 'Registration fee in cents of BRL; 0 = free' },
  waitlist_enabled: { type: 'boolean', description: 'Whether refused registrations may wait for a seat (handled by subscription)' },
};

export const createEventBody = object(eventFields, { required: ['title', 'starts_at', 'ends_at'] });
export const patchEventBody = object(eventFields, { minProperties: 1 });

const capacity = { type: 'integer', minimum: 1, maximum: 100_000, description: 'Seats; immutable after creation' };
export const createActivityBody = object({ ...activityFields, capacity }, { required: ['title', 'starts_at', 'ends_at', 'capacity'] });
/** No `capacity`: sending it is a 400, since it never changes. */
export const patchActivityBody = object(activityFields, { minProperties: 1 });

export const eventParams = object({ eventId: uuid }, { required: ['eventId'] });
export const activityParams = object({ activityId: uuid }, { required: ['activityId'] });

export const listQuery = object({
  q: { type: 'string', maxLength: 200, description: 'Text searched in title, description, organization and location' },
  from: { ...dateTime, description: 'Only events ending at or after this instant' },
  to: { ...dateTime, description: 'Only events starting at or before this instant' },
  limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  offset: { type: 'integer', minimum: 0, default: 0 },
});

// ---- Responses ----------------------------------------------------------------------------------

const timestamps = { created_at: dateTime, updated_at: dateTime };

export const eventSchema = {
  type: 'object',
  properties: {
    id: uuid,
    organizer_id: { type: 'string' },
    title: { type: 'string' },
    organization: nullable({ type: 'string' }),
    description: nullable({ type: 'string' }),
    location: nullable({ type: 'string' }),
    banner_url: nullable({ type: 'string' }),
    starts_at: dateTime,
    ends_at: dateTime,
    status: { type: 'string', enum: [...EVENT_STATUSES] },
    ...timestamps,
  },
} as const;

export const activitySchema = {
  type: 'object',
  properties: {
    id: uuid,
    event_id: uuid,
    title: { type: 'string' },
    description: nullable({ type: 'string' }),
    speaker: nullable({ type: 'string' }),
    location: nullable({ type: 'string' }),
    starts_at: dateTime,
    ends_at: dateTime,
    capacity: { type: 'integer' },
    available: { type: 'integer', description: 'Seats not held by any registration (RF04 "vagas")' },
    price_cents: { type: 'integer' },
    paid: { type: 'boolean' },
    waitlist_enabled: { type: 'boolean' },
    ...timestamps,
  },
} as const;

export const eventDetailSchema = {
  type: 'object',
  properties: { ...eventSchema.properties, activities: { type: 'array', items: activitySchema } },
} as const;

export const eventPageSchema = {
  type: 'object',
  properties: {
    items: { type: 'array', items: eventSchema },
    total: { type: 'integer' },
    limit: { type: 'integer' },
    offset: { type: 'integer' },
  },
} as const;

export const activityListSchema = { type: 'object', properties: { items: { type: 'array', items: activitySchema } } } as const;
