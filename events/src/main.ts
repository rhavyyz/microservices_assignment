import type { Consumer } from 'kafkajs';
import { createAudit } from './audit.ts';
import { loadConfig } from './config.ts';
import { createPool, migrate } from './db/pool.ts';
import { consult, register } from './discovery.ts';
import { createTokenVerifier, fetchJwks } from './http/auth.ts';
import { registerRoutes } from './http/routes.ts';
import { buildServer } from './http/server.ts';
import { createKafka, createPublisher, ensureTopics, startConsumer } from './messaging/kafka.ts';
import { createOutboxRelay } from './messaging/relay.ts';
import { retryForever } from './retry.ts';
import { createEventService } from './services/events.ts';
import { createSeatService } from './services/seats.ts';

const KIND = 'events';
const config = loadConfig();

const pool = createPool(config.databaseUrl);
const app = await buildServer({ pool });
const log = app.log;
pool.on('error', (e) => log.error({ err: e.message }, 'postgres pool error'));

const deps = { pool, topic: config.eventsTopic, audit: createAudit(log) };
const seats = createSeatService(deps);
const discovery = { url: config.discovererUrl, log: (m: string) => log.warn(m) };

// Access Token: the user service's public keys, from JWT_JWKS_URL or located through the discoverer.
const verifyToken = createTokenVerifier({
  issuer: config.jwtIssuer,
  cacheSeconds: config.jwksCacheSeconds,
  fetchKeys: async () => fetchJwks(config.jwksUrl ?? `http://${await consult('user', discovery)}/.well-known/jwks.json`),
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
  relay.start(); // the relay itself retries while Kafka is down; messages wait in the outbox
  await retryForever('kafka topics', () => ensureTopics(kafka, config), retryLog);
  await retryForever('kafka consumer', async () => { consumer = await startConsumer(kafka, config, seats, log); }, retryLog);
  log.info({ topic: config.subscriptionTopic }, 'consuming seat requests');
})();

// Server-side discovery: register now and again periodically. The discoverer keeps its registry in
// memory and drops hosts that stay unhealthy, so a periodic (idempotent) register brings us back.
void register(KIND, config.serviceHost, discovery)
  .then(() => log.info({ host: config.serviceHost }, 'registered in the service-discoverer'))
  .catch((e) => log.error({ err: (e as Error).message }, 'registration gave up; the periodic register keeps trying'));
const reregister = setInterval(() => {
  register(KIND, config.serviceHost, { ...discovery, attempts: 1 }).catch(() => {});
}, config.reregisterIntervalMs);
reregister.unref();

async function shutdown(): Promise<void> {
  clearInterval(reregister);
  await app.close().catch(() => {});
  await relay.stop().catch(() => {});
  await consumer?.disconnect().catch(() => {});
  await publisher.disconnect();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
