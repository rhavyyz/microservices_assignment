import type { Consumer } from 'kafkajs';
import type { Pool } from 'pg';
import { config } from './config.ts';
import { parseSubscriptionMessage } from './contracts.ts';
import { kafka } from './kafka.ts';
import { cancelForRegistration } from './payments.ts';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

/** Reads registration.cancelled / registration.expired and cancels the registration's pending payment. */
export async function startConsumer(pool: Pool, log: Log): Promise<Consumer> {
  const consumer = kafka.consumer({ groupId: config.consumerGroup });
  try {
    await consumer.connect();
    await consumer.subscribe({ topics: [config.subscriptionTopic], fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const where = { topic, partition, offset: message.offset };
        const raw = message.value?.toString('utf8');
        if (!raw) {
          log.warn(where, 'empty message skipped');
          return;
        }
        const parsed = parseSubscriptionMessage(raw);
        if (!parsed.ok) {
          // Poison message: skip it, otherwise one bad record would block the partition forever.
          log.warn({ ...where, error: parsed.error }, 'invalid message skipped');
          return;
        }
        const m = parsed.value;
        // A database error throws: the offset is not committed and kafkajs redelivers (idempotent).
        let result: string;
        if (m.cancel) {
          result = await cancelForRegistration(pool, m.messageId, m.cancel.registrationId, m.cancel.reason, m.correlationId);
        } else {
          result = 'ignored'; // no effect, so nothing to dedupe
        }
        log.info({ ...where, type: m.type, message_id: m.messageId, correlation_id: m.correlationId, result }, 'message processed');
      },
    });
  } catch (e) {
    await consumer.disconnect().catch(() => {});
    throw e;
  }
  return consumer;
}
