import type { Log } from '../audit.ts';
import { withTransaction } from '../db/pool.ts';
import { envelope } from '../messaging/envelope.ts';
import { activityLifecycleMessage } from '../messaging/messages.ts';
import { endDueActivities } from '../repositories/activities.ts';
import { addToOutbox } from '../repositories/outbox.ts';
import type { ServiceDeps } from '../services/unit-of-work.ts';

export type AutoEndOptions = {
  deps: ServiceDeps;
  /** An activity still open this long after its scheduled `ends_at` is ended. */
  autoEndAfterSeconds: number;
  log: Log;
  /** Time between runs. */
  intervalMs?: number;
  /** Activities ended (and announced) per transaction. */
  batchSize?: number;
};

const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_BATCH_SIZE = 100;

/**
 * Automatic end of activities: the organizer may end an activity by hand after its scheduled end; the ones
 * nobody ended are ended here `autoEndAfterSeconds` after `ends_at`. Each batch is one transaction holding the
 * change and one ActivityEnded per activity (Transactional Outbox, trace_id null); each ended activity gets an
 * audit line without actor, none when nothing was due. The rows are locked with SKIP LOCKED, so several replicas can run it without ending one twice.
 * The clock of the messages is `deps.now`; which activities are due is decided by the database clock.
 */
export function createActivityAutoEnd(opts: AutoEndOptions) {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;

  /** Ends one batch; returns how many activities it ended. */
  async function endBatch(): Promise<number> {
    const { deps } = opts;
    const ended = await withTransaction(deps.pool, async (tx) => {
      const due = await endDueActivities(tx, opts.autoEndAfterSeconds, batchSize);
      for (const activity of due) {
        const m = activityLifecycleMessage('ActivityEnded', activity);
        await addToOutbox(tx, { topic: deps.topic, key: m.key, envelope: envelope(m.type, m.data, null, deps.now?.()) });
      }
      return due;
    });
    for (const a of ended) {
      deps.audit({ operation: 'ACTIVITY_AUTO_END', user_id: null, trace_id: null, event_id: a.event_id, activity_id: a.id, result: 'SUCCESS' });
    }
    if (ended.length > 0) opts.log.info({ count: ended.length }, 'activities ended automatically');
    return ended.length;
  }

  let running: Promise<number> | null = null;

  /** One run (batches until nothing is due); a run that starts while another is still going is skipped (returns 0). */
  function runOnce(): Promise<number> {
    if (running) return Promise.resolve(0);
    running = (async () => {
      let total = 0;
      try {
        for (;;) {
          const n = await endBatch();
          total += n;
          if (n < batchSize) break;
        }
      } catch (e) {
        opts.log.warn({ err: (e as Error).message }, 'automatic end of activities failed; will retry');
      }
      return total;
    })().finally(() => { running = null; });
    return running;
  }

  let timer: NodeJS.Timeout | null = null;

  return {
    runOnce,
    /** Runs now (to catch up after downtime) and then every interval. The timer never keeps the process alive. */
    start(): void {
      if (timer) return;
      timer = setInterval(() => void runOnce(), intervalMs);
      timer.unref();
      void runOnce();
    },
    /** Stops the timer and waits for the run in progress. */
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = null;
      await running;
    },
  };
}
