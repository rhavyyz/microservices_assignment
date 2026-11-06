import { Kafka, logLevel, type Admin, type Producer } from 'kafkajs';
import { config } from './config.ts';

export const kafka = new Kafka({ clientId: 'reports', brokers: config.kafkaBrokers, logLevel: logLevel.WARN });

/** Creates the topics we use if missing (idempotent), so the service can boot before any producer. */
export async function ensureTopics(admin: Pick<Admin, 'connect' | 'createTopics' | 'disconnect'> = kafka.admin()): Promise<void> {
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: [...config.topics, config.dlqTopic].map((topic) => ({
        topic,
        numPartitions: config.topicPartitions,
        replicationFactor: 1,
      })),
    });
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

/** Reference to a message that could not be processed: where it is and why, never its content. */
export type DeadLetter = { source_topic: string; partition: number; offset: number; reason: string };

/** Publishes a reference to the DLQ; throws when there is no producer yet or Kafka does not confirm. */
export function dlqPublisher(getProducer: () => Pick<Producer, 'send'> | undefined): (ref: DeadLetter) => Promise<void> {
  return async (ref) => {
    const producer = getProducer();
    if (!producer) throw new Error('dlq producer not ready');
    await producer.send({
      topic: config.dlqTopic,
      acks: -1,
      messages: [{ key: `${ref.source_topic}:${ref.partition}`, value: JSON.stringify(ref) }],
    });
  };
}
