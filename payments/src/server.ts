import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import swagger from '@fastify/swagger';
import type { Pool } from 'pg';
import { config } from './config.ts';
import { validateCreate } from './contracts.ts';
import { createPayment, getById, getByRegistration, settleById, type PaymentRow } from './payments.ts';
import type { Status } from './state.ts';

const str = { type: 'string' } as const;
const paymentSchema = {
  type: 'object',
  properties: {
    payment_id: str,
    registration_id: str,
    user_id: str,
    event_id: str,
    activity_id: str,
    amount: { type: 'number' },
    currency: str,
    status: { type: 'string', enum: ['PENDING', 'CONFIRMED', 'REFUSED', 'EXPIRED', 'CANCELLED'] },
    expires_at: { type: 'string', format: 'date-time' },
    created_at: { type: 'string', format: 'date-time' },
  },
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function userIdOf(req: FastifyRequest): string | null {
  const v = req.headers['x-user-id'];
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t : null;
}

// Helpers take an untyped reply: a route whose schema lists only some status codes rejects the others.
async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<string | null> {
  const userId = userIdOf(req);
  if (!userId) {
    await reply.code(401).type('text/plain').send('missing X-User-Id');
    return null;
  }
  return userId;
}

function fail(reply: FastifyReply, code: number, body: object): FastifyReply {
  return reply.code(code).send(body);
}

function view(p: PaymentRow) {
  return {
    payment_id: p.payment_id,
    registration_id: p.registration_id,
    user_id: p.user_id,
    event_id: p.event_id,
    activity_id: p.activity_id,
    amount: p.amount,
    currency: p.currency,
    status: p.status,
    expires_at: p.expires_at,
    created_at: p.created_at,
  };
}

const ACTIONS: Record<string, { target: Status; reason: string }> = {
  confirm: { target: 'CONFIRMED', reason: 'simulated_confirmation' },
  refuse: { target: 'REFUSED', reason: 'simulated_refusal' },
  expire: { target: 'EXPIRED', reason: 'simulated_expiration' },
};

export async function buildServer(pool: Pool) {
  const app = Fastify({ logger: true, requestIdHeader: 'x-correlation-id', genReqId: () => randomUUID() });

  await app.register(swagger, { openapi: { info: { title: 'Payments service', version: '1.0.0' } } });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-correlation-id', req.id);
  });

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

  // Internal: called by the subscription service through the discoverer. Keep it private in the gateway.
  app.post('/payments', {
    schema: {
      summary: 'Start a payment for a reservation (internal; idempotent by registration_id)',
      body: {
        type: 'object',
        required: ['registration_id', 'user_id', 'event_id', 'activity_id', 'amount', 'expires_at'],
        properties: {
          registration_id: str,
          user_id: str,
          event_id: str,
          activity_id: str,
          amount: { type: 'number' },
          currency: str,
          expires_at: { type: 'string', format: 'date-time' },
        },
      },
      response: { 200: paymentSchema, 201: paymentSchema },
    },
  }, async (req, reply) => {
    const v = validateCreate(req.body, new Date());
    if (!v.ok) return fail(reply, 400, { error: v.error });
    const { payment, created } = await createPayment(pool, v.value, req.id);
    if (!created && (payment.user_id !== v.value.userId || payment.amount !== v.value.amount)) {
      return fail(reply, 409, { error: 'a payment for this registration already exists with different data' });
    }
    return reply.code(created ? 201 : 200).send(view(payment));
  });

  // Owner check: anything that is not the caller's payment is a 404, same as an unknown one.
  async function owned(req: FastifyRequest, reply: FastifyReply, find: () => Promise<PaymentRow | null>): Promise<PaymentRow | null> {
    const userId = await requireUser(req, reply);
    if (!userId) return null;
    const p = await find();
    if (!p || p.user_id !== userId) {
      fail(reply, 404, { error: 'payment not found' });
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

  // The simulated external provider: the payer "pays" (confirm), is declined (refuse) or lets it lapse (expire).
  app.post('/payments/:paymentId/simulate', {
    schema: {
      summary: 'Simulated provider: confirm, refuse or expire a pending payment',
      params: { type: 'object', properties: { paymentId: str }, required: ['paymentId'] },
      body: {
        type: 'object',
        required: ['action'],
        properties: { action: { type: 'string', enum: ['confirm', 'refuse', 'expire'] } },
      },
      response: { 200: paymentSchema },
    },
  }, async (req, reply) => {
    if (!config.simulatorEnabled) return fail(reply, 404, { error: 'not found' });
    const { paymentId } = req.params as { paymentId: string };
    const { action } = req.body as { action: string };
    const p = await owned(req, reply, async () => (UUID.test(paymentId) ? getById(pool, paymentId) : null));
    if (!p) return reply;
    const { target, reason } = ACTIONS[action];
    const res = await settleById(pool, p.payment_id, target, reason, req.id);
    if (!res) return fail(reply, 404, { error: 'payment not found' });
    // Not applied as asked (already final, or the deadline passed): 409 with the real status.
    if (res.outcome === 'rejected') return fail(reply, 409, { error: res.detail, status: res.payment.status });
    return view(res.payment);
  });

  return app;
}
