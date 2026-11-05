import { createAudit } from './audit.ts';
import { loadConfig } from './config.ts';
import { createPool, migrate } from './db/pool.ts';
import { Kind, register } from 'discovery';
import { registerRoutes } from './http/routes.ts';
import { buildServer } from './http/server.ts';
import { createActivityAutoEnd } from './jobs/auto-end.ts';
import { createKafka, createPublisher, ensureTopics } from './messaging/kafka.ts';
import { createOutboxRelay } from './messaging/relay.ts';
import { retryForever } from './retry.ts';
import { createEventService } from './services/events.ts';

const config = loadConfig();

const pool = createPool(config.databaseUrl);
let migrated = false;
const app = await buildServer({ pool, isReady: () => migrated });
const log = app.log;
pool.on('error', (e) => log.error({ err: e.message }, 'postgres pool error'));

const deps = { pool, topic: config.eventsTopic, audit: createAudit(log) };
registerRoutes(app, { events: createEventService(deps) });

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
const autoEnd = createActivityAutoEnd({
  deps, autoEndAfterSeconds: config.activityAutoEndAfterSeconds, log,
});

void (async () => {
  await retryForever('migration', () => migrate(pool), retryLog);
  migrated = true;
  autoEnd.start(); // only writes to the database (the outbox), so it does not wait for Kafka
  // Topics first: otherwise the broker would auto-create them with a single partition on the first send.
  // Until then (and whenever Kafka is down) the messages simply wait in the outbox.
  await retryForever('kafka topics', () => ensureTopics(kafka, config), retryLog);
  relay.start();
})();

// Server-side discovery: register once; the lib retries with its default settings. Never awaited.
register(Kind.EVENTS)
  .then(() => log.info('registered in the service-discoverer'))
  .catch((e: Error) => log.warn({ err: e.message }, 'could not register in the service-discoverer'));

async function shutdown(): Promise<void> {
  await app.close().catch(() => {});
  await autoEnd.stop().catch(() => {});
  await relay.stop().catch(() => {});
  await publisher.disconnect();
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
