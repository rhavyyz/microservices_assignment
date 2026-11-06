import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest, type FastifyServerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import type { Pool } from 'pg';
import {
  activitiesSection,
  activityLifecycleSection,
  attendanceSection,
  countActivities,
  countOwnedEvents,
  findEvent,
  listOwnedEvents,
  occupancySection,
  paymentsSection,
  registrationsSection,
  type EventRow,
} from './queries.ts';
import { accessLogOptions, bindUserToLog } from './access-log.ts';

const int = { type: 'integer' } as const;
const str = { type: 'string' } as const;
const rate = { type: ['number', 'null'] } as const;
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties }) as const;

// Money is integer minor units (cents) grouped by currency; different currencies are never summed together.
const moneySchema = {
  type: 'array',
  items: obj({ currency: { type: 'string' }, amount_minor: int }),
} as const;

const registrationsSchema = obj({
  pending_payment: int, offered: int, confirmed: int, waitlisted: int, cancelled: int, expired: int, rejected: int, total: int,
});
const paymentsSchema = obj({
  pending: int, approved: int, declined: int, expired: int, cancelled: int, refunded_count: int,
  revenue: moneySchema, refunded: moneySchema,
});
const occupancySchema = obj({ capacity: int, occupied: int, rate });
const attendanceSchema = obj({
  confirmed: int, checkins: int, rate, certificate_eligible: int, certificate_eligible_rate: rate,
});
const lifecycleCountsSchema = obj({ open: int, ended: int, cancelled: int });
const eventSchema = obj({
  event_id: { type: 'string' },
  name: { type: ['string', 'null'] },
  status: { type: 'string' },
  starts_at: { type: ['string', 'null'], format: 'date-time' },
  ends_at: { type: ['string', 'null'], format: 'date-time' },
});
const activitySchema = obj({
  activity_id: { type: 'string' }, name: { type: ['string', 'null'] }, capacity: { type: ['integer', 'null'] },
  paid: { type: 'boolean' }, lifecycle: str, ended_at: { type: ['string', 'null'], format: 'date-time' },
  pending_payment: int, offered: int, confirmed: int, waitlisted: int, cancelled: int,
  expired: int, rejected: int, payments_approved: int, revenue: moneySchema, refunded: moneySchema,
  occupied: int, occupancy_rate: rate,
  checkins: int, attendance_rate: rate,
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TRACE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** X-Trace-Id: kept when it is 8-64 chars of [A-Za-z0-9._-], otherwise a fresh UUID. */
export function traceIdFrom(header: string | string[] | undefined): string {
  const v = (Array.isArray(header) ? header[0] : header)?.trim();
  return v && TRACE_ID.test(v) ? v : randomUUID();
}

/**
 * The caller's identity (X-User-Id, set by the gateway): must be a UUID, else null. X-User-Roles is not used:
 * the only access rule is ownership of the event.
 */
export function userIdOf(req: FastifyRequest): string | null {
  const v = req.headers['x-user-id'];
  const t = (Array.isArray(v) ? v[0] : v)?.trim();
  return t && UUID.test(t) ? t : null;
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  500: 'Internal Server Error',
};

/** Error response as application/problem+json; traceId is the request's trace id. */
export function problem(reply: FastifyReply, status: number, code: string, detail?: string): FastifyReply {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ title: TITLES[status] ?? 'Error', status, code, ...(detail ? { detail } : {}), traceId: reply.request.id });
}

// Error bodies for the OpenAPI document (and the serializer): RFC 9457 style, with a stable `code`.
const problemSchema = {
  type: 'object',
  properties: { title: str, status: int, code: str, detail: str, traceId: str },
  required: ['title', 'status', 'code', 'traceId'],
} as const;
const problemResponse = (description: string) =>
  ({ description, content: { 'application/problem+json': { schema: problemSchema } } }) as const;

const errorResponses = {
  401: problemResponse('UNAUTHENTICATED: X-User-Id is missing or not a UUID'),
  404: problemResponse('EVENT_NOT_FOUND: the event does not exist or is not owned by the caller'),
  500: problemResponse('INTERNAL_ERROR'),
} as const;
const validationResponse = { 400: problemResponse('VALIDATION_ERROR: invalid query parameters') } as const;

// Every business route is public through the gateway, with a verified user (the gateway sets X-User-Id from the JWT).
// Declared in the operation, read by the gateway's OpenAPI sync (insert-only: it applies when the endpoint is first created).
const gatewaySettings = { isPublic: true, requireAuth: true } as const;
const businessRoute = { 'x-gateway': gatewaySettings, security: [{ userId: [] }] } as const;

// Helpers take an untyped reply: a route whose schema lists only some status codes rejects the others.
async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const userId = userIdOf(req);
  if (!userId) {
    await problem(reply, 401, 'UNAUTHENTICATED', 'X-User-Id header is missing or not a UUID');
    return null;
  }
  return userId;
}

const pageQuery = {
  type: 'object',
  properties: {
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
    offset: { type: 'integer', minimum: 0, default: 0 },
  },
} as const;

const paged = (item: unknown, extra: Record<string, unknown> = {}) =>
  obj({ items: { type: 'array', items: item }, total: int, limit: int, offset: int, ...extra });

/** `migrated` tells whether the first migration succeeded: /healthcheck is 503 until then. */
export async function buildServer(pool: Pool, migrated: () => boolean = () => true, logger?: FastifyServerOptions['logger']) {
  const app = Fastify({
    ...accessLogOptions(logger),
    requestIdHeader: false,
    genReqId: (req) => traceIdFrom(req.headers['x-trace-id']),
  });

  bindUserToLog(app);

  await app.register(swagger, {
    openapi: {
      info: { title: 'Reports service', version: '1.0.0' },
      components: {
        securitySchemes: {
          userId: {
            type: 'apiKey',
            in: 'header',
            name: 'X-User-Id',
            description: 'UUID of the caller, set by the gateway from the verified JWT. Missing or not a UUID: 401.',
          },
        },
      },
    },
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-trace-id', req.id);
  });

  // Every error leaves as application/problem+json; internals of 5xx stay in the log.
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500 || status < 400) {
      req.log.error({ err }, 'request failed');
      return problem(reply, 500, 'INTERNAL_ERROR');
    }
    if (status === 400) return problem(reply, 400, 'VALIDATION_ERROR', (err as Error).message);
    if (status === 404) return problem(reply, 404, 'NOT_FOUND', (err as Error).message);
    return problem(reply, status, 'REQUEST_REJECTED', (err as Error).message);
  });

  app.setNotFoundHandler((_req, reply) => problem(reply, 404, 'NOT_FOUND', 'route not found'));

  // Private through the gateway (x-gateway isPublic false): the discoverer polls the status code.
  app.get('/healthcheck', { schema: { 'x-gateway': { isPublic: false, requireAuth: false }, summary: 'Liveness + first migration + database ping' } }, async (_req, reply) => {
    if (!migrated()) return reply.code(503).send({ status: 'unavailable' });
    try {
      await Promise.race([
        pool.query('SELECT 1'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('ping timeout')), 2000).unref()),
      ]);
      return reply.code(200).send({ status: 'ok' });
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  // Authorization (RN07): only the organizer that owns the event sees its reports. Anything else (unknown id, not a
  // UUID, someone else's event) is the same 404, so nothing leaks. X-User-Id is the gateway's identity; X-User-Roles
  // is deliberately not used.
  async function owned(req: FastifyRequest, reply: FastifyReply): Promise<EventRow | null> {
    const userId = await requireUser(req, reply);
    if (!userId) return null;
    const { eventId } = req.params as { eventId: string };
    const ev = UUID.test(eventId) ? await findEvent(pool, eventId) : null; // no database hit for a malformed id
    if (!ev || ev.organizer_id !== userId) {
      await problem(reply, 404, 'EVENT_NOT_FOUND', 'event not found');
      return null;
    }
    return ev;
  }

  const params = { type: 'object', properties: { eventId: str }, required: ['eventId'] } as const;

  app.get('/events', {
    schema: {
      ...businessRoute,
      summary: 'Events owned by the caller (paginated)',
      querystring: pageQuery,
      response: { 200: paged(eventSchema), ...validationResponse, 401: errorResponses[401], 500: errorResponses[500] },
    },
  }, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return reply;
    const { limit, offset } = req.query as { limit: number; offset: number };
    const [items, total] = await Promise.all([
      listOwnedEvents(pool, userId, { limit, offset }),
      countOwnedEvents(pool, userId),
    ]);
    return { items, total, limit, offset };
  });

  app.get('/events/:eventId/summary', {
    schema: {
      ...businessRoute,
      summary: 'All indicators of an event',
      params,
      response: {
        200: obj({
          event: eventSchema,
          registrations: registrationsSchema,
          payments: paymentsSchema,
          occupancy: occupancySchema,
          attendance: attendanceSchema,
          activities: lifecycleCountsSchema,
        }),
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const ev = await owned(req, reply);
    if (!ev) return reply;
    const [registrations, payments, occupancy, attendance, activities] = await Promise.all([
      registrationsSection(pool, ev.event_id),
      paymentsSection(pool, ev.event_id),
      occupancySection(pool, ev.event_id),
      attendanceSection(pool, ev.event_id),
      activityLifecycleSection(pool, ev.event_id),
    ]);
    return { event: ev, registrations, payments, occupancy, attendance, activities };
  });

  app.get('/events/:eventId/activities', {
    schema: {
      ...businessRoute,
      summary: 'Indicators per activity (paginated)',
      params,
      querystring: pageQuery,
      response: { 200: paged(activitySchema, { activities: lifecycleCountsSchema }), ...validationResponse, ...errorResponses },
    },
  }, async (req, reply) => {
    const ev = await owned(req, reply);
    if (!ev) return reply;
    const { limit, offset } = req.query as { limit: number; offset: number };
    const [items, total, activities] = await Promise.all([
      activitiesSection(pool, ev.event_id, { limit, offset }),
      countActivities(pool, ev.event_id),
      activityLifecycleSection(pool, ev.event_id),
    ]);
    return { items, total, limit, offset, activities };
  });

  app.get('/events/:eventId/registrations', {
    schema: {
      ...businessRoute,
      summary: 'Registrations by status',
      params,
      response: { 200: registrationsSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const ev = await owned(req, reply);
    if (!ev) return reply;
    return registrationsSection(pool, ev.event_id);
  });

  app.get('/events/:eventId/payments', {
    schema: {
      ...businessRoute,
      summary: 'Payments by status, revenue and refunds by currency (integer minor units)',
      params,
      response: { 200: paymentsSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const ev = await owned(req, reply);
    if (!ev) return reply;
    return paymentsSection(pool, ev.event_id);
  });

  app.get('/events/:eventId/attendance', {
    schema: {
      ...businessRoute,
      summary: 'Check-ins versus confirmed registrations',
      params,
      response: { 200: attendanceSchema, ...errorResponses },
    },
  }, async (req, reply) => {
    const ev = await owned(req, reply);
    if (!ev) return reply;
    return attendanceSection(pool, ev.event_id);
  });

  return app;
}
