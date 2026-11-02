import { Kafka, logLevel } from 'kafkajs';
import { config } from './config.ts';

export const kafka = new Kafka({ clientId: 'payments', brokers: config.kafkaBrokers, logLevel: logLevel.WARN });

/** Creates the topics we use if missing (idempotent), so the service can boot before any other. */
export async function ensureTopics(): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: [config.paymentsTopic, config.subscriptionTopic, config.notificationsTopic].map((topic) => ({
        topic,
        numPartitions: config.topicPartitions,
        replicationFactor: 1,
      })),
    });
  } finally {
    await admin.disconnect().catch(() => {});
  }
}
