import type pg from 'pg';
import type { Audit, AuditEntry } from '../audit.ts';
import { withTransaction, type Queryable } from '../db/pool.ts';
import type { Actor } from '../domain/model.ts';
import { AppError } from '../errors.ts';
import { envelope } from '../messaging/envelope.ts';
import type { Outgoing } from '../messaging/messages.ts';
import { addToOutbox } from '../repositories/outbox.ts';

export type ServiceDeps = {
  pool: pg.Pool;
  /** Topic every message of this service goes to. */
  topic: string;
  audit: Audit;
  now?: () => Date;
};

/** Who asked (null for anonymous reads and for messages) and the id that ties logs and messages together. */
export type Ctx = { actor: Actor | null; correlationId: string | null };
/** Context of an authenticated request (the HTTP layer guarantees the actor). */
export type AuthedCtx = Ctx & { actor: Actor };

export type Work = {
  tx: Queryable;
  /** Queues a message in the outbox, in this transaction: it is published only if the change commits. */
  publish: (m: Outgoing) => Promise<void>;
  /** Ids of what the operation touched, filled in as they become known; they go to the audit line. */
  target: Pick<AuditEntry, 'event_id' | 'activity_id' | 'registration_id' | 'code'>;
};

/**
 * Every state change runs here: one transaction holding the change and its messages (Transactional
 * Outbox), then one audit line. Expected refusals (AppError) are audited as FAILURE and rethrown;
 * unexpected errors are rethrown untouched for the caller's exception tracking.
 */
export function createUnitOfWork(deps: ServiceDeps) {
  return async function run<T>(operation: string, ctx: Ctx, fn: (w: Work) => Promise<T>): Promise<T> {
    const target: Work['target'] = {};
    const base = { operation, user_id: ctx.actor?.userId ?? null, correlation_id: ctx.correlationId };
    try {
      const result = await withTransaction(deps.pool, (tx) =>
        fn({
          tx,
          target,
          publish: (m) => addToOutbox(tx, {
            topic: deps.topic,
            key: m.key,
            envelope: envelope(m.type, m.data, ctx.correlationId, deps.now?.()),
          }),
        }),
      );
      deps.audit({ ...base, ...target, result: 'SUCCESS' });
      return result;
    } catch (e) {
      if (e instanceof AppError) deps.audit({ ...base, ...target, result: 'FAILURE', code: e.code });
      throw e;
    }
  };
}

export type UnitOfWork = ReturnType<typeof createUnitOfWork>;
