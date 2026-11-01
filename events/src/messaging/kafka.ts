// The kafkajs edge of the service: topic setup, the outbox publisher and the subscription consumer.
import { Kafka, logLevel, type Consumer, type Producer, type TopicMessages } from 'kafkajs';
import type { Log } from '../audit.ts';
import type { Config } from '../config.ts';
import type { OutboxMessage } from '../repositories/outbox.ts';
import type { SeatService } from '../services/seats.ts';
import { handleRecord } from './consumer.ts';
import type { Publisher } from './relay.ts';

export function createKafka(config: Config): Kafka {
  return new Kafka({ clientId: 'events', brokers: config.kafkaBrokers, logLevel: logLevel.WARN });
}

/** Creates the topics this service uses when missing (idempotent), so it can start before any other service. */
export async function ensureTopics(kafka: Kafka, config: Config): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  try {
    await admin.createTopics({
      waitForLeaders: true,
      topics: [config.eventsTopic, config.subscriptionTopic].map((topic) => ({
        topic, numPartitions: config.topicPartitions, replicationFactor: 1,
      })),
    });
  } finally {
    await admin.disconnect().catch(() => {});
  }
}

/**
 * Publisher for the outbox relay. Idempotent producer with one request in flight: no duplicates from
 * producer retries and the batch keeps its order within each partition. Connects lazily and again
 * after a failure, so a broker outage only delays the messages.
 */
export function createPublisher(kafka: Kafka): { publish: Publisher; disconnect: () => Promise<void> } {
  let producer: Producer | null = null;

  async function connected(): Promise<Producer> {
    if (!producer) {
      const p = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
      await p.connect();
      producer = p;
    }
    return producer;
  }

  return {
    async publish(messages) {
      const p = await connected();
      try {
        await p.sendBatch({ topicMessages: byTopic(messages) });
      } catch (e) {
        producer = null;
        await p.disconnect().catch(() => {});
        throw e;
      }
    },
    async disconnect() {
      await producer?.disconnect().catch(() => {});
    },
  };
}

/** Kafka records grouped by topic, in outbox order within each topic. */
function byTopic(messages: OutboxMessage[]): TopicMessages[] {
  const groups = new Map<string, TopicMessages>();
  for (const m of messages) {
    const group = groups.get(m.topic) ?? { topic: m.topic, messages: [] };
    group.messages.push({
      key: m.key,
      value: JSON.stringify(m.envelope),
      headers: { 'message-type': m.envelope.type, 'correlation-id': m.envelope.correlation_id ?? '' },
    });
    groups.set(m.topic, group);
  }
  return [...groups.values()];
}

/** Joins the consumer group and processes the subscription topic (Idempotent Consumer, see consumer.ts). */
export async function startConsumer(kafka: Kafka, config: Config, seats: SeatService, log: Log): Promise<Consumer> {
  const consumer = kafka.consumer({ groupId: config.consumerGroup });
  try {
    await consumer.connect();
    // A new group starts from the beginning: requests made while this service never ran are still answered.
    await consumer.subscribe({ topics: [config.subscriptionTopic], fromBeginning: true });
    await consumer.run({
      eachMessage: ({ topic, partition, message }) =>
        handleRecord(message.value?.toString('utf8'), { topic, partition, offset: message.offset }, seats, log),
    });
  } catch (e) {
    await consumer.disconnect().catch(() => {});
    throw e;
  }
  return consumer;
}
