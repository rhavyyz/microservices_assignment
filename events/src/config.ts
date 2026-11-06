type Env = Record<string, string | undefined>;

function str(env: Env, name: string, def: string): string {
  const v = env[name]?.trim();
  return v ? v : def;
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
    /** Topic this service publishes to (consumed by subscription and others). The service consumes nothing. */
    eventsTopic: str(env, 'EVENTS_TOPIC', 'events.events'),
    topicPartitions: int(env, 'EVENTS_TOPIC_PARTITIONS', 6),
    outboxIntervalMs: int(env, 'OUTBOX_INTERVAL_MS', 500),
    outboxBatchSize: int(env, 'OUTBOX_BATCH_SIZE', 100),
    outboxRetentionHours: int(env, 'OUTBOX_RETENTION_HOURS', 24),
    /** An activity still open this long after its scheduled `ends_at` is ended automatically (default one day). */
    activityAutoEndAfterSeconds: int(env, 'ACTIVITY_AUTO_END_AFTER_SECONDS', 86400),
  };
}

export type Config = ReturnType<typeof loadConfig>;
