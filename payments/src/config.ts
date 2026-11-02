import os from 'node:os';

function int(name: string, def: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

function str(name: string, def: string): string {
  const v = process.env[name]?.trim();
  return v ? v : def;
}

const port = int('PORT', 8080);

export const config = {
  port,
  databaseUrl: str('DATABASE_URL', 'postgres://payments:change-me@payments-db:5432/payments'),
  kafkaBrokers: str('KAFKA_BROKERS', 'kafka:9092').split(',').map((s) => s.trim()).filter(Boolean),
  consumerGroup: str('PAYMENTS_CONSUMER_GROUP', 'payments-service'),
  paymentsTopic: str('PAYMENTS_TOPIC', 'payments-events'),
  subscriptionTopic: str('SUBSCRIPTION_TOPIC', 'subscription-events'),
  notificationsTopic: str('NOTIFICATIONS_TOPIC', 'notifications'),
  topicPartitions: int('PAYMENTS_TOPIC_PARTITIONS', 6),
  expiryIntervalMs: int('EXPIRY_INTERVAL_MS', 5000),
  outboxIntervalMs: int('OUTBOX_INTERVAL_MS', 500),
  // The simulated provider endpoint (confirm / refuse / expire). Turn it off with SIMULATOR_ENABLED=false.
  simulatorEnabled: str('SIMULATOR_ENABLED', 'true').toLowerCase() !== 'false',
  discovererUrl: str('SERVICE_DISCOVERER_URL', 'http://service-discoverer:8080'),
  serviceHost: str('SERVICE_HOST', `${os.hostname()}:${port}`),
};
