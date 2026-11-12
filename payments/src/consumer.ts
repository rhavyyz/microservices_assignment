import type { Consumer } from 'kafkajs';
import type { Pool } from 'pg';
import { config } from './config.ts';
import { parseSubscriptionMessage } from './contracts.ts';
import { kafka } from './kafka.ts';
import { closeForRegistration } from './payments.ts';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };

/**
 * Handles one raw message of `subscription.events`. Invalid messages are logged (ids only, never the payload) and
 * skipped; unknown types are ignored. A database error throws, so the offset is not committed and the message is
 * redelivered (the processed_messages dedupe makes that safe).
 */
export async function handleSubscriptionMessage(
  pool: Pool,
  raw: string | undefined,
  where: Record<string, unknown>,
  log: Log,
): Promise<string> {
  if (!raw) {
    log.warn(where, 'empty message skipped');
    return 'invalid';
  }
  const parsed = parseSubscriptionMessage(raw);
  if (!parsed.ok) {
    // Poison message: skip it, otherwise one bad record would block the partition forever.
    log.warn({ ...where, error: parsed.error }, 'invalid message skipped');
    return 'invalid';
  }
  const m = parsed.value;
  if (!m.closeReason) return 'ignored'; // not a type we react to: no effect, nothing to dedupe
  const result = await closeForRegistration(pool, m.messageId, m.registrationId, m.closeReason, m.traceId);
  log.info({ ...where, type: m.type, message_id: m.messageId, registration_id: m.registrationId, trace_id: m.traceId, result }, 'message processed');
  return result;
}

/** Reads Subscription's domain events and closes the registration's payment (cancel if pending, refund if approved). */
export async function startConsumer(pool: Pool, log: Log): Promise<Consumer> {
  // metadataMaxAge = topic.metadata.refresh.interval.ms (DT-05): picks up a topic created after we subscribed.
  const consumer = kafka.consumer({ groupId: config.consumerGroup, metadataMaxAge: 10000 });
  try {
    await consumer.connect();
    await consumer.subscribe({ topics: [config.subscriptionTopic], fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        await handleSubscriptionMessage(pool, message.value?.toString('utf8'), { topic, partition, offset: message.offset }, log);
      },
    });
  } catch (e) {
    await consumer.disconnect().catch(() => {});
    throw e;
  }
  return consumer;
}
