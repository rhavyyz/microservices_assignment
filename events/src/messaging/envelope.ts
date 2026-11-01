import { randomUUID } from 'node:crypto';

/**
 * Envelope shared by every service on the bus (the format the reports service already consumes):
 * `message_id` is unique and stable on resend (the consumers' idempotency key) and `correlation_id`
 * follows a registration across services (RQ06).
 */
export type Envelope = {
  message_id: string;
  type: string;
  version: 1;
  occurred_at: string;
  correlation_id: string | null;
  data: Record<string, unknown>;
};

export function envelope(
  type: string,
  data: Record<string, unknown>,
  correlationId: string | null,
  now: Date = new Date(),
): Envelope {
  return { message_id: randomUUID(), type, version: 1, occurred_at: now.toISOString(), correlation_id: correlationId, data };
}
