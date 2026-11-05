import { randomUUID } from 'node:crypto';

/**
 * Flat envelope, the same style Subscription and Payments publish: the fields of the message sit next to
 * the envelope fields (no nested `data`). `message_id` is unique and stable on resend (the consumers'
 * idempotency key) and `trace_id` follows a request across services (RQ06); it is null for work started
 * by the service itself (the automatic end of activities).
 */
export type Envelope = {
  message_id: string;
  schema_version: 1;
  type: string;
  occurred_at: string;
  trace_id: string | null;
} & Record<string, unknown>;

export function envelope(
  type: string,
  fields: Record<string, unknown>,
  traceId: string | null,
  now: Date = new Date(),
): Envelope {
  // The envelope fields come last: a message field can never override them.
  return { ...fields, message_id: randomUUID(), schema_version: 1, type, occurred_at: now.toISOString(), trace_id: traceId };
}
