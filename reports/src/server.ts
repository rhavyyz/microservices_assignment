import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import type { Pool } from 'pg';
import {
  activitiesSection,
  attendanceSection,
  findEvent,
  listOwnedEvents,
  occupancySection,
  paymentsSection,
  registrationsSection,
  type EventRow,
} from './queries.ts';

const int = { type: 'integer' } as const;
const rate = { type: ['number', 'null'] } as const;
const obj = (properties: Record<string, unknown>) => ({ type: 'object', properties }) as const;

const registrationsSchema = obj({ pending: int, confirmed: int, waitlisted: int, cancelled: int, expired: int, total: int });
const paymentsSchema = obj({ pending: int, confirmed: int, refused: int, expired: int, cancelled: int, revenue: { type: 'number' } });
const occupancySchema = obj({ capacity: int, occupied: int, rate });
const attendanceSchema = obj({ confirmed: int, checkins: int, rate });
const eventSchema = obj({
  event_id: { type: 'string' },
  name: { type: ['string', 'null'] },
  status: { type: 'string' },
  starts_at: { type: ['string', 'null'], format: 'date-time' },
  ends_at: { type: ['string', 'null'], format: 'date-time' },
});
const activitySchema = obj({
  activity_id: { type: 'string' }, name: { type: ['string', 'null'] }, capacity: { type: ['integer', 'null'] },
  paid: { type: 'boolean' }, pending: int, confirmed: int, waitlisted: int, cancelled: int, expired: int,
  payments_confirmed: int, revenue: { type: 'number' }, occupied: int, occupancy_rate: rate,
  checkins: int, attendance_rate: rate,
});

function userIdOf(req: FastifyRequest): string | null {
  const v = req.headers['x-user-id'];
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t : null;
}

async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const userId = userIdOf(req);
  if (!userId) {
    await reply.code(401).type('text/plain').send('missing X-User-Id');
    return null;
  }
  return userId;
}

export async function buildServer(pool: Pool) {
  const app = Fastify({ logger: true, requestIdHeader: 'x-correlation-id', genReqId: () => randomUUID() });

  await app.register(swagger, {
    openapi: { info: { title: 'Reports service', version: '1.0.0' } },
  });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-correlation-id', req.id);
  });

  // Never leak internals on 5xx (same policy as the other services).
  app.setErrorHandler((err, req, reply) => {
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.code(500).send({ error: 'internal error' });
    }
    return reply.code(status).send({ error: (err as Error).message });
  });

  app.get('/healthcheck', { schema: { summary: 'Liveness + database ping' } }, async (_req, reply) => {
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

  // Authorization (RN07): only the organizer that owns the event sees its reports. Anything else is a
  // 404, the same as an unknown event, so nothing leaks. X-User-Id is the gateway's (unverified) identity.
  async function owned(req: FastifyRequest, reply: FastifyReply): Promise<EventRow | null> {
    const userId = await requireUser(req, reply);
    if (!userId) return null;
    const { eventId } = req.params as { eventId: string };
    const ev = await findEvent(pool, eventId);
    if (!ev || ev.organizer_id !== userId) {
      await reply.code(404).send({ error: 'event not found' });
      return null;
    }
    return ev;
  }

  const params = { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'] } as const;

  app.get('/events', {
    schema: {
      summary: 'Events owned by the caller',
      response: { 200: obj({ items: { type: 'array', items: eventSchema } }) },
    },
  }, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return reply;
    return { items: await listOwnedEvents(pool, userId) };
  });

  app.get('/events/:eventId/summary', {
    schema: {
      summary: 'All indicators of an event',
      params,
      response: {
        200: obj({
          event: eventSchema,
          registrations: registrationsSchema,
          payments: paymentsSchema,
          occupancy: occupancySchema,
          attendance: attendanceSchema,
        }),
      },
    },
  }, async (req, reply) => {
    const ev = await owned(req, reply);
    if (!ev) return reply;
    const [registrations, payments, occupancy, attendance] = await Promise.all([
      registrationsSection(pool, ev.event_id),
      paymentsSection(pool, ev.event_id),
      occupancySection(pool, ev.event_id),
      attendanceSection(pool, ev.event_id),
    ]);
    return { event: ev, registrations, payments, occupancy, attendance };
  });

  app.get('/events/:eventId/activities', {
    schema: {
      summary: 'Indicators per activity',
      params,
      response: { 200: obj({ items: { type: 'array', items: activitySchema } }) },
    },
  }, async (req, reply) => {
    const ev = await owned(req, reply);
    if (!ev) return reply;
    return { items: await activitiesSection(pool, ev.event_id) };
  });

  app.get('/events/:eventId/registrations', {
    schema: { summary: 'Registrations by status', params, response: { 200: registrationsSchema } },
  }, async (req, reply) => {
    const ev = await owned(req, reply);
    if (!ev) return reply;
    return registrationsSection(pool, ev.event_id);
  });

  app.get('/events/:eventId/payments', {
    schema: { summary: 'Payments by status and revenue', params, response: { 200: paymentsSchema } },
  }, async (req, reply) => {
    const ev = await owned(req, reply);
    if (!ev) return reply;
    return paymentsSection(pool, ev.event_id);
  });

  app.get('/events/:eventId/attendance', {
    schema: { summary: 'Check-ins versus confirmed registrations', params, response: { 200: attendanceSchema } },
  }, async (req, reply) => {
    const ev = await owned(req, reply);
    if (!ev) return reply;
    return attendanceSection(pool, ev.event_id);
  });

  return app;
}
