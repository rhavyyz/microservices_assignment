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
  databaseUrl: str('DATABASE_URL', 'postgres://reports:reports@reports-db:5432/reports'),
  kafkaBrokers: str('KAFKA_BROKERS', 'kafka:9092').split(',').map((s) => s.trim()).filter(Boolean),
  consumerGroup: str('REPORTS_CONSUMER_GROUP', 'reports-service'),
  topics: [
    str('EVENTS_TOPIC', 'events.events'),
    str('SUBSCRIPTION_TOPIC', 'subscription.events'),
    str('PAYMENTS_TOPIC', 'payments.events'),
  ],
  dlqTopic: str('REPORTS_DLQ_TOPIC', 'reports.dlq'),
  topicPartitions: int('REPORTS_TOPIC_PARTITIONS', 6),
};
