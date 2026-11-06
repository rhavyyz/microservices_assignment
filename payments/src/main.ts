import { Kind, register } from 'discovery';
import type { Consumer, Producer } from 'kafkajs';
import { config } from './config.ts';
import { startConsumer } from './consumer.ts';
import { createPool, migrate } from './db.ts';
import { startExpiryJob } from './expiry.ts';
import { ensureTopics, kafka } from './kafka.ts';
import { startOutboxWorker } from './outbox.ts';
import { buildServer } from './server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const pool = createPool();

const app = await buildServer(pool);
const log = app.log;
pool.on('error', (e) => log.error({ err: e.message }, 'postgres pool error'));

async function retryForever(name: string, fn: () => Promise<void>): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await fn();
      return;
    } catch (e) {
      const delay = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
      log.warn({ err: (e as Error).message }, `${name} failed; retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
}

// The HTTP server boots first, even when Postgres, Kafka or the discoverer are down;
// everything else runs in the background. While Kafka is down, events wait in the outbox table.
await app.listen({ host: '0.0.0.0', port: config.port });

let producer: Producer | undefined;
let consumer: Consumer | undefined;
const stoppers: Array<() => void> = [];

void (async () => {
  await retryForever('migrate', () => migrate(pool));
  stoppers.push(startExpiryJob(pool, log, config.expiryIntervalMs));
  stoppers.push(startOutboxWorker(pool, () => producer, log, config.outboxIntervalMs));

  await retryForever('kafka topics', ensureTopics);
  void retryForever('kafka producer', async () => {
    const p = kafka.producer({ allowAutoTopicCreation: false });
    await p.connect();
    producer = p;
  });
  void retryForever('kafka consumer', async () => {
    consumer = await startConsumer(pool, log);
  });
})();

register(Kind.PAYMENTS)
  .then(() => log.info('registered in the service-discoverer'))
  .catch((e) => log.warn({ err: (e as Error).message }, 'could not register in the service-discoverer'));

async function shutdown(): Promise<void> {
  stoppers.forEach((stop) => stop());
  await app.close().catch(() => {});
  await consumer?.disconnect().catch(() => {});
  await producer?.disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
