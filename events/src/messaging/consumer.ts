import type { Log } from '../audit.ts';
import type { SeatService } from '../services/seats.ts';
import { parseCommand } from './commands.ts';

export type RecordRef = { topic: string; partition: number; offset: string };

/**
 * Handles one record of the subscription topic. Malformed records are logged and skipped (one bad
 * record must not block its partition forever); types this service does not care about are skipped.
 * A database error propagates, so the offset is not committed and the record is redelivered, which
 * is safe because the seat service applies each message id once.
 */
export async function handleRecord(raw: string | undefined, where: RecordRef, seats: SeatService, log: Log): Promise<void> {
  if (!raw) {
    log.warn(where, 'empty message skipped');
    return;
  }
  const parsed = parseCommand(raw);
  if (!parsed.ok) {
    log.warn({ ...where, error: parsed.error }, 'invalid message skipped');
    return;
  }
  const { messageId, type, traceId, command } = parsed.value;
  if (!command) return;
  const outcome = await seats.handle(messageId, traceId, command);
  log.info({ ...where, type, message_id: messageId, trace_id: traceId, outcome }, 'message processed');
}
