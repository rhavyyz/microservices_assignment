import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyServerOptions } from 'fastify';
import swagger from '@fastify/swagger';
import type pg from 'pg';
import { ping } from '../db/pool.ts';
import { AppError } from '../errors.ts';
import { requestIdFrom, toProblem } from './problems.ts';

export type ServerDeps = {
  pool: pg.Pool;
  /** False until the schema migration ran: the instance must not get traffic before that. */
  isReady: () => boolean;
  logger?: FastifyServerOptions['logger'];
};

/** The app with its cross-cutting parts (ids, errors, health, OpenAPI); the API routes come from routes.ts. */
export async function buildServer(deps: ServerDeps) {
  const app = Fastify({
    logger: deps.logger ?? true,
    // The gateway's X-Request-Id becomes the request id: it is on every log line, in error bodies and
    // in the correlation_id of the messages this request produces (RQ06).
    requestIdHeader: false,
    genReqId: (req) => requestIdFrom(req.headers['x-request-id'], randomUUID),
    // Unknown fields are rejected (400), never silently dropped: e.g. `capacity` in a PATCH.
    ajv: { customOptions: { removeAdditional: false } },
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Events service', version: '1.0.0', description: 'Events, schedule (activities), search and seats. Through the gateway: /events/...' },
      components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    },
  });

  app.addHook('onRequest', async (req, reply) => {
    reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err: unknown, req, reply) => {
    const { problem, unexpected } = toProblem(err, req.id);
    if (unexpected) req.log.error({ err }, 'request failed'); // Exception tracking: full error only in the log
    return reply.code(problem.status).type('application/problem+json').send(problem);
  });

  app.setNotFoundHandler((req, reply) => {
    const { problem } = toProblem(new AppError(404, 'NOT_FOUND', 'route not found'), req.id);
    return reply.code(404).type('application/problem+json').send(problem);
  });

  // Health check API, used by the service-discoverer: healthy only when migrated and the database answers.
  // Kafka being down does not make the instance unhealthy (HTTP reads and writes keep working, RQ03).
  app.get('/healthcheck', { schema: { hide: true } }, async (_req, reply) => {
    try {
      if (!deps.isReady()) throw new Error('not migrated yet');
      await ping(deps.pool);
      return reply.code(200).send({ status: 'ok' });
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  app.get('/openapi.json', { schema: { hide: true } }, async () => app.swagger());

  return app;
}
