import os from 'node:os';

type Env = Record<string, string | undefined>;

function str(env: Env, name: string, def: string): string {
  const v = env[name]?.trim();
  return v ? v : def;
}

function optStr(env: Env, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

function int(env: Env, name: string, def: number): number {
  const v = env[name]?.trim();
  if (!v) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function list(env: Env, name: string, def: string): string[] {
  return str(env, name, def).split(',').map((s) => s.trim()).filter(Boolean);
}

/** Reads the configuration from the environment; an invalid value stops the service at startup. */
export function loadConfig(env: Env = process.env) {
  const port = int(env, 'PORT', 8080);
  return {
    port,
    databaseUrl: str(env, 'DATABASE_URL', 'postgres://events:events@events-db:5432/events'),
    kafkaBrokers: list(env, 'KAFKA_BROKERS', 'kafka:9092'),
    consumerGroup: str(env, 'EVENTS_CONSUMER_GROUP', 'events-service'),
    /** Topic this service publishes to (consumed by reports, subscription, notifications...). */
    eventsTopic: str(env, 'EVENTS_TOPIC', 'events-events'),
    /** Topic this service consumes seat requests from (produced by the subscription service). */
    subscriptionTopic: str(env, 'SUBSCRIPTION_TOPIC', 'subscription-events'),
    topicPartitions: int(env, 'EVENTS_TOPIC_PARTITIONS', 6),
    outboxIntervalMs: int(env, 'OUTBOX_INTERVAL_MS', 500),
    outboxBatchSize: int(env, 'OUTBOX_BATCH_SIZE', 100),
    outboxRetentionHours: int(env, 'OUTBOX_RETENTION_HOURS', 24),
    discovererUrl: str(env, 'SERVICE_DISCOVERER_URL', 'http://service-discoverer:8080'),
    serviceHost: str(env, 'SERVICE_HOST', `${os.hostname()}:${port}`),
    reregisterIntervalMs: int(env, 'REREGISTER_INTERVAL_MS', 30000),
    jwtIssuer: str(env, 'JWT_ISSUER', 'eventhub-users'),
    /** Fixed JWKS URL; when absent the user service is located through the service-discoverer. */
    jwksUrl: optStr(env, 'JWT_JWKS_URL'),
    jwksCacheSeconds: int(env, 'JWKS_CACHE_SECONDS', 300),
  };
}

export type Config = ReturnType<typeof loadConfig>;
