import { Kind, register } from 'discovery';
import type { Consumer } from 'kafkajs';
import { config } from './config.ts';
import { startConsumer } from './consumer.ts';
import { createPool, migrate } from './db.ts';
import { buildServer } from './server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const pool = createPool();
pool.on('error', (e) => console.error('postgres pool error:', e.message));

const app = await buildServer(pool);
const log = app.log;

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

let consumer: Consumer | undefined;

void (async () => {
  await retryForever('migrate', () => migrate(pool));
  await retryForever('kafka consumer', async () => {
    consumer = await startConsumer(pool, log);
  });
})();

// Fire and forget, never awaited before listening.
register(Kind.REPORTS)
  .then(() => log.info('registered in the service-discoverer'))
  .catch((e: Error) => log.warn({ err: e.message }, 'could not register in the service-discoverer'));

async function shutdown(): Promise<void> {
  await app.close().catch(() => {});
  await consumer?.disconnect().catch(() => {});
  await pool.end().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
