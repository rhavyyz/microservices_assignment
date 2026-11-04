import { Kafka, logLevel, type Consumer } from 'kafkajs';
import type { Pool } from 'pg';
import { config } from './config.ts';
import { parseMessage } from './contracts.ts';
import { processMessage } from './projection.ts';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

export async function startConsumer(pool: Pool, log: Log): Promise<Consumer> {
  const kafka = new Kafka({ clientId: 'reports', brokers: config.kafkaBrokers, logLevel: logLevel.WARN });

  // Create the topics if missing (idempotent), so the service can boot before any producer.
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: config.topics.map((topic) => ({ topic, numPartitions: config.topicPartitions, replicationFactor: 1 })),
    });
  } finally {
    await admin.disconnect().catch(() => {});
  }

  const consumer = kafka.consumer({ groupId: config.consumerGroup });
  try {
    await consumer.connect();
    // New group reads from the start: the read model is rebuilt from the full history.
    await consumer.subscribe({ topics: config.topics, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const raw = message.value?.toString('utf8');
        const where = { topic, partition, offset: message.offset };
        if (!raw) {
          log.warn(where, 'empty message skipped');
          return;
        }
        const parsed = parseMessage(raw);
        if (!parsed.ok) {
          // Poison message: skip it, otherwise one bad record would block the partition forever.
          log.warn({ ...where, error: parsed.error }, 'invalid message skipped');
          return;
        }
        // A database error throws: the offset is not committed and kafkajs redelivers (idempotent).
        const result = await processMessage(pool, parsed.value);
        log.info(
          { ...where, type: parsed.value.envelope.type, message_id: parsed.value.envelope.message_id,
            correlation_id: parsed.value.envelope.correlation_id, result },
          'message processed',
        );
      },
    });
  } catch (e) {
    await consumer.disconnect().catch(() => {});
    throw e;
  }
  return consumer;
}
