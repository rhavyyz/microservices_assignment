import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import type { Pool } from 'pg';
import { config } from './config.ts';
import { validateCreate } from './contracts.ts';
import { createPayment, getById, getByRegistration, settleById, type PaymentRow } from './payments.ts';
import type { Status } from './state.ts';
import { fetchRegistration, type FetchRegistration } from './subscription.ts';

const str = { type: 'string' } as const;
const paymentSchema = {
  type: 'object',
  properties: {
    payment_id: str,
    registration_id: str,
    user_id: str,
    event_id: { type: ['string', 'null'] },
    amount_minor: { type: 'integer' },
    currency: str,
    status: { type: 'string', enum: ['PENDING', 'APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED', 'REFUNDED'] },
    expires_at: { type: 'string', format: 'date-time' },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TRACE_ID = /^[A-Za-z0-9._-]{8,64}$/;

/** X-Trace-Id: kept when it is 8-64 chars of [A-Za-z0-9._-], otherwise a fresh UUID. */
export function traceIdFrom(header: string | string[] | undefined): string {
  const v = (Array.isArray(header) ? header[0] : header)?.trim();
  return v && TRACE_ID.test(v) ? v : randomUUID();
}

/** The caller's identity (X-User-Id, set by the gateway): must be a UUID, else null. */
export function userIdOf(req: FastifyRequest): string | null {
  const v = req.headers['x-user-id'];
  const t = (Array.isArray(v) ? v[0] : v)?.trim();
  return t && UUID.test(t) ? t : null;
}

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  409: 'Conflict',
  500: 'Internal Server Error',
  503: 'Service Unavailable',
};

/** Error response as application/problem+json; traceId is the trace id. `extra` adds fields (e.g. payment_status). */
export function problem(
  reply: FastifyReply,
  status: number,
  code: string,
  detail?: string,
  extra: Record<string, unknown> = {},
): FastifyReply {
  return reply
    .code(status)
    .type('application/problem+json')
    .send({ ...extra, title: TITLES[status] ?? 'Error', status, code, ...(detail ? { detail } : {}), traceId: reply.request.id });
}

// Helpers take an untyped reply: a route whose schema lists only some status codes rejects the others.
async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const userId = userIdOf(req);
  if (!userId) {
    await problem(reply, 401, 'UNAUTHENTICATED', 'X-User-Id header is missing or not a UUID');
    return null;
  }
  return userId;
}

function view(p: PaymentRow) {
  return {
    payment_id: p.payment_id,
    registration_id: p.registration_id,
    user_id: p.user_id,
    event_id: p.event_id,
    amount_minor: p.amount_minor,
    currency: p.currency,
    status: p.status,
    expires_at: p.expires_at,
    created_at: p.created_at,
  };
}

const ACTIONS: Record<string, { target: Status; reason: string }> = {
  approve: { target: 'APPROVED', reason: 'simulated_approval' },
  decline: { target: 'DECLINED', reason: 'simulated_decline' },
  expire: { target: 'EXPIRED', reason: 'simulated_expiration' },
};

export async function buildServer(pool: Pool, lookup: FetchRegistration = fetchRegistration, now: () => Date = () => new Date()) {
  // coerceTypes off: Fastify's default would turn "2500" into 2500 before validation; the contract says integer.
  const app = Fastify({
    logger: true,
    requestIdHeader: false,
    genReqId: (req) => traceIdFrom(req.headers['x-trace-id']),
    ajv: { customOptions: { coerceTypes: false } },
  });

  await app.register(swagger, { openapi: { info: { title: 'Payments service', version: '1.0.0' } } });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-trace-id', req.id);
  });

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

  // Participant-facing creation. The facts (owner, status, amount, currency) come from Subscription, never from the client.
  app.post('/payments', {
    schema: {
      summary: 'Start the payment of a registration (idempotent by registration_id)',
      body: {
        type: 'object',
        required: ['registration_id'],
        properties: { registration_id: str },
      },
      response: { 200: paymentSchema, 201: paymentSchema },
    },
  }, async (req, reply) => {
    const userId = await requireUser(req, reply);
    if (!userId) return reply;
    const v = validateCreate(req.body);
    if (!v.ok) return problem(reply, 400, 'VALIDATION_ERROR', v.error);
    const { registrationId } = v.value;
    const notFound = () => problem(reply, 404, 'REGISTRATION_NOT_FOUND', 'registration not found');
    const sameUser = (other: string) => other.toLowerCase() === userId.toLowerCase();

    // Already has a payment: return it unchanged (owner check only), without asking Subscription again.
    const existing = await getByRegistration(pool, registrationId);
    if (existing) return sameUser(existing.user_id) ? reply.code(200).send(view(existing)) : notFound();

    const found = await lookup(registrationId, req.id);
    if (found.kind === 'unavailable') {
      req.log.warn({ reason: found.reason }, 'subscription lookup failed');
      return problem(reply, 503, 'UPSTREAM_UNAVAILABLE', 'registration data is temporarily unavailable');
    }
    // Someone else's registration looks exactly like an unknown one.
    if (found.kind === 'not_found' || !sameUser(found.registration.user_id)) return notFound();
    const r = found.registration;
    if (r.status !== 'PENDING_PAYMENT') {
      return problem(reply, 409, 'REGISTRATION_NOT_PAYABLE', `registration is ${r.status}, not PENDING_PAYMENT`);
    }

    // Subscription's expiry worker lags by a few seconds: a stale PENDING_PAYMENT may already be past its reservation.
    // The parser guarantees both are set for PENDING_PAYMENT; this only narrows the types.
    if (r.expires_at === null || r.amount_minor === null) {
      return problem(reply, 503, 'UPSTREAM_UNAVAILABLE', 'registration data is temporarily unavailable');
    }
    if (Date.parse(r.expires_at) <= now().getTime()) {
      return problem(reply, 409, 'REGISTRATION_NOT_PAYABLE', 'the registration reservation has expired');
    }

    const { payment, created } = await createPayment(pool, {
      registrationId,
      userId: r.user_id,
      eventId: r.parent_event_id,
      amountMinor: r.amount_minor,
      currency: r.currency,
      expiresAt: new Date(now().getTime() + config.paymentTtlSeconds * 1000),
    }, req.id);
    if (!created && !sameUser(payment.user_id)) return notFound(); // lost a race against another creation
    return reply.code(created ? 201 : 200).send(view(payment));
  });

  // Owner check: anything that is not the caller's payment is a 404, same as an unknown one.
  async function owned(req: FastifyRequest, reply: FastifyReply, find: () => Promise<PaymentRow | null>): Promise<PaymentRow | null> {
    const userId = await requireUser(req, reply);
    if (!userId) return null;
    const p = await find();
    if (!p || p.user_id !== userId) {
      problem(reply, 404, 'PAYMENT_NOT_FOUND', 'payment not found');
      return null;
    }
    return p;
  }

  app.get('/payments/:paymentId', {
    schema: {
      summary: 'Payment status',
      params: { type: 'object', properties: { paymentId: str }, required: ['paymentId'] },
      response: { 200: paymentSchema },
    },
  }, async (req, reply) => {
    const { paymentId } = req.params as { paymentId: string };
    const p = await owned(req, reply, async () => (UUID.test(paymentId) ? getById(pool, paymentId) : null));
    if (!p) return reply;
    return view(p);
  });

  app.get('/payments', {
    schema: {
      summary: 'Payment of a registration',
      querystring: { type: 'object', properties: { registration_id: str }, required: ['registration_id'] },
      response: { 200: paymentSchema },
    },
  }, async (req, reply) => {
    const { registration_id } = req.query as { registration_id: string };
    const p = await owned(req, reply, () => getByRegistration(pool, registration_id.trim()));
    if (!p) return reply;
    return view(p);
  });

  // The simulated external provider: the payer "pays" (approve), is declined (decline) or lets it lapse (expire).
  app.post('/payments/:paymentId/simulate', {
    schema: {
      summary: 'Simulated provider: approve, decline or expire a pending payment',
      params: { type: 'object', properties: { paymentId: str }, required: ['paymentId'] },
      body: {
        type: 'object',
        required: ['action'],
        properties: { action: { type: 'string', enum: ['approve', 'decline', 'expire'] } },
      },
      response: { 200: paymentSchema },
    },
  }, async (req, reply) => {
    if (!config.simulatorEnabled) return problem(reply, 404, 'NOT_FOUND', 'not found');
    const { paymentId } = req.params as { paymentId: string };
    const { action } = req.body as { action: string };
    const p = await owned(req, reply, async () => (UUID.test(paymentId) ? getById(pool, paymentId) : null));
    if (!p) return reply;
    const { target, reason } = ACTIONS[action];
    const res = await settleById(pool, p.payment_id, target, reason, req.id);
    if (!res) return problem(reply, 404, 'PAYMENT_NOT_FOUND', 'payment not found');
    // Not applied as asked (already final, or the deadline passed): 409 with the real status.
    if (res.outcome === 'rejected') return problem(reply, 409, 'PAYMENT_NOT_APPLIED', res.detail, { payment_status: res.payment.status });
    return view(res.payment);
  });

  return app;
}
