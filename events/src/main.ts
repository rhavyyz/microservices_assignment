import type { Consumer } from 'kafkajs';
import { createAudit } from './audit.ts';
import { loadConfig } from './config.ts';
import { createPool, migrate } from './db/pool.ts';
import { Kind, register, request } from 'discovery';
import { createTokenVerifier, fetchJwks } from './http/auth.ts';
import { registerRoutes } from './http/routes.ts';
import { buildServer } from './http/server.ts';
import { createKafka, createPublisher, ensureTopics, startConsumer } from './messaging/kafka.ts';
import { createOutboxRelay } from './messaging/relay.ts';
import { retryForever } from './retry.ts';
import { createEventService } from './services/events.ts';
import { createSeatService } from './services/seats.ts';

const config = loadConfig();

const pool = createPool(config.databaseUrl);
let migrated = false;
const app = await buildServer({ pool, isReady: () => migrated });
const log = app.log;
pool.on('error', (e) => log.error({ err: e.message }, 'postgres pool error'));

const deps = { pool, topic: config.eventsTopic, audit: createAudit(log) };
const seats = createSeatService(deps);

// Access Token: the user service's public keys, from JWT_JWKS_URL or located through the discoverer (lib `request`).
const verifyToken = createTokenVerifier({
  issuer: config.jwtIssuer,
  cacheSeconds: config.jwksCacheSeconds,
  // JWT_JWKS_URL is a fixed URL (no lookup); otherwise the shared lib locates the user service.
  fetchKeys: () => fetchJwks(() => config.jwksUrl
    ? fetch(config.jwksUrl, { signal: AbortSignal.timeout(3000) })
    : request('GET', Kind.USER, '/.well-known/jwks.json')),
  onKeysError: (e) => log.warn({ err: e.message }, 'could not download the access token keys'),
});
registerRoutes(app, { events: createEventService(deps), verifyToken });

// The HTTP server starts first, even when PostgreSQL, Kafka or the discoverer are down (RQ03);
// everything else starts in the background and retries until it works.
await app.listen({ host: '0.0.0.0', port: config.port });
const retryLog = (name: string, e: Error, delay: number) => log.warn({ err: e.message }, `${name} failed; retrying in ${delay}ms`);

const kafka = createKafka(config);
const publisher = createPublisher(kafka);
const relay = createOutboxRelay({
  pool, publish: publisher.publish, log,
  batchSize: config.outboxBatchSize, intervalMs: config.outboxIntervalMs, retentionHours: config.outboxRetentionHours,
});
let consumer: Consumer | undefined;

void (async () => {
  await retryForever('migration', () => migrate(pool), retryLog);
  migrated = true;
  // Topics first: otherwise the broker would auto-create them with a single partition on the first send.
  // Until then (and whenever Kafka is down) the messages simply wait in the outbox.
  await retryForever('kafka topics', () => ensureTopics(kafka, config), retryLog);
  relay.start();
  await retryForever('kafka consumer', async () => { consumer = await startConsumer(kafka, config, seats, log); }, retryLog);
  log.info({ topic: config.subscriptionTopic }, 'consuming seat requests');
})();

// Server-side discovery: register once; the lib retries with its default settings. Never awaited.
register(Kind.EVENTS)
  .then(() => log.info('registered in the service-discoverer'))
  .catch((e: Error) => log.warn({ err: e.message }, 'could not register in the service-discoverer'));

async function shutdown(): Promise<void> {
  await app.close().catch(() => {});
  await relay.stop().catch(() => {});
  await consumer?.disconnect().catch(() => {});
  await publisher.disconnect();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
