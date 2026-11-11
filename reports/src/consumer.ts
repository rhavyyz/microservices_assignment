import type { Consumer } from 'kafkajs';
import type { Pool } from 'pg';
import { config } from './config.ts';
import { parseMessage } from './contracts.ts';
import { kafka, type DeadLetter } from './kafka.ts';
import { processMessage } from './projection.ts';

type Log = { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
type Where = { topic: string; partition: number; offset: string };

const MAX_REASON = 200;

/**
 * Handles one raw message. A message that is invalid (empty, unparsable JSON, contract violation, unsupported
 * schema_version) is published to the DLQ as a reference only (topic, partition, offset, reason; never the payload)
 * and then skipped, otherwise one bad record would block the partition forever. Unknown types are ignored without
 * the DLQ. A database or DLQ failure throws, so the offset is not committed and the message is redelivered
 * (the processed_messages dedupe makes that safe).
 */
export async function handleMessage(
  pool: Pool,
  raw: string | undefined,
  where: Where,
  log: Log,
  publishDlq: (ref: DeadLetter) => Promise<void>,
): Promise<string> {
  const parsed = raw ? parseMessage(raw) : ({ ok: false, error: 'empty message' } as const);
  if (!parsed.ok) {
    await publishDlq({
      source_topic: where.topic,
      partition: where.partition,
      offset: Number(where.offset),
      reason: parsed.error.slice(0, MAX_REASON),
    });
    log.warn({ ...where, error: parsed.error }, 'invalid message sent to the DLQ');
    return 'invalid';
  }
  const result = await processMessage(pool, parsed.value);
  log.info(
    { ...where, type: parsed.value.envelope.type, message_id: parsed.value.envelope.message_id,
      trace_id: parsed.value.envelope.trace_id, result },
    'message processed',
  );
  return result;
}

export type ConsumerHooks = {
  publishDlq: (ref: DeadLetter) => Promise<void>;
  /** Called when kafkajs gives up on the consumer (CRASH without its own restart); the caller starts a new one. */
  onCrash: (error: Error) => void;
};

export async function startConsumer(pool: Pool, log: Log, hooks: ConsumerHooks): Promise<Consumer> {
  // metadataMaxAge = topic.metadata.refresh.interval.ms (DT-05): picks up a topic created after we subscribed.
  const consumer = kafka.consumer({ groupId: config.consumerGroup, metadataMaxAge: 10000 });
  // kafkajs restarts by itself while payload.restart is true; only a final crash needs us.
  consumer.on(consumer.events.CRASH, (e) => {
    if (!e.payload.restart) hooks.onCrash(e.payload.error);
  });
  try {
    await consumer.connect();
    // New group reads from the start: the read model is rebuilt from the full history.
    await consumer.subscribe({ topics: config.topics, fromBeginning: true });
    await consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        await handleMessage(
          pool, message.value?.toString('utf8'), { topic, partition, offset: message.offset }, log, hooks.publishDlq,
        );
      },
    });
  } catch (e) {
    await consumer.disconnect().catch(() => {});
    throw e;
  }
  return consumer;
}
