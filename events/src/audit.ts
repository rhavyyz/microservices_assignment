/** Minimal structured logger (Fastify's pino logger satisfies it). */
export type Log = {
  info: (obj: object, msg: string) => void;
  warn: (obj: object, msg: string) => void;
  error: (obj: object, msg: string) => void;
};

export type AuditEntry = {
  operation: string;
  result: 'SUCCESS' | 'FAILURE';
  user_id?: string | null;
  trace_id?: string | null;
  event_id?: string;
  activity_id?: string;
  registration_id?: string;
  /** Error code of a refused operation, or the outcome detail of a seat operation. */
  code?: string;
};

/**
 * Audit Logging: one structured line per state-changing operation, marked `audit: true` so it can be
 * filtered out of the regular logs. Never contains tokens, secrets or personal data beyond ids.
 */
export function createAudit(log: Log) {
  return (entry: AuditEntry): void => {
    const line = { audit: true, ...entry };
    if (entry.result === 'SUCCESS') log.info(line, 'audit');
    else log.warn(line, 'audit');
  };
}

export type Audit = ReturnType<typeof createAudit>;
