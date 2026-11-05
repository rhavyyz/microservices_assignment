import { Kafka, logLevel, type Admin } from 'kafkajs';
import { config } from './config.ts';

export const kafka = new Kafka({ clientId: 'payments', brokers: config.kafkaBrokers, logLevel: logLevel.WARN });

/** Creates the topics we use if missing (idempotent), so the service can boot before any other. */
export async function ensureTopics(admin: Pick<Admin, 'connect' | 'createTopics' | 'disconnect'> = kafka.admin()): Promise<void> {
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: [config.paymentEventsTopic, config.notificationsTopic, config.subscriptionTopic].map((topic) => ({
        topic,
        numPartitions: config.topicPartitions,
        replicationFactor: 1,
      })),
    });
  } finally {
    await admin.disconnect().catch(() => {});
  }
}
