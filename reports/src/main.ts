import { Kind, register } from 'discovery';
import type { Consumer, Producer } from 'kafkajs';
import { config } from './config.ts';
import { startConsumer } from './consumer.ts';
import { createPool, migrate } from './db.ts';
import { dlqPublisher, ensureTopics, kafka } from './kafka.ts';
import { buildServer } from './server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const pool = createPool();

// /healthcheck answers 503 until the first successful migration.
let migrated = false;

const app = await buildServer(pool, () => migrated);
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

// The HTTP server boots first, even when Postgres, Kafka or the discoverer are down (RQ03);
// everything else runs in the background.
await app.listen({ host: '0.0.0.0', port: config.port });

let producer: Producer | undefined;
let consumer: Consumer | undefined;
let stopping = false;

const publishDlq = dlqPublisher(() => producer);

/** Starts the consumer (retrying until it connects); restarts it after a delay if kafkajs gives up on it. */
async function superviseConsumer(): Promise<void> {
  await retryForever('kafka consumer', async () => {
    consumer = await startConsumer(pool, log, {
      publishDlq,
      onCrash: (error) => {
        if (stopping) return;
        log.error({ err: error.message }, 'kafka consumer crashed; restarting in 5000ms');
        const crashed = consumer;
        consumer = undefined;
        void (async () => {
          await crashed?.disconnect().catch(() => {});
          await sleep(5000);
          if (!stopping) await superviseConsumer();
        })();
      },
    });
  });
}

void (async () => {
  await retryForever('migrate', () => migrate(pool));
  migrated = true;
  await retryForever('kafka topics', ensureTopics);
  // The DLQ producer connects in the background; until it is up, an invalid message fails transiently and is redelivered.
  void retryForever('kafka producer', async () => {
    const p = kafka.producer({ allowAutoTopicCreation: false });
    await p.connect();
    producer = p;
  });
  await superviseConsumer();
})();

// Fire and forget, never awaited before listening.
register(Kind.REPORTS)
  .then(() => log.info('registered in the service-discoverer'))
  .catch((e: Error) => log.warn({ err: e.message }, 'could not register in the service-discoverer'));

async function shutdown(): Promise<void> {
  stopping = true;
  await app.close().catch(() => {});
  await consumer?.disconnect().catch(() => {});
  await producer?.disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
