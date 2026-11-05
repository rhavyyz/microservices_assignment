import type { Queryable } from '../db/pool.ts';
import { seatRejection } from '../domain/rules.ts';
import type { ReservationRow } from '../domain/model.ts';
import { isUuid, type SeatCommand } from '../messaging/commands.ts';
import { seatRejected, seatReleased, seatReserved, type SeatRef } from '../messaging/messages.ts';
import { findActivity, giveBackSeat, takeSeat } from '../repositories/activities.ts';
import { findEvent } from '../repositories/events.ts';
import { claimMessage } from '../repositories/processed.ts';
import { findReservation, holdReservation, lockRegistration, releaseReservation } from '../repositories/reservations.ts';
import { createUnitOfWork, type ServiceDeps, type Work } from './unit-of-work.ts';

/** What happened to a consumed message (logged by the consumer, written to the audit line). */
export type SeatOutcome = 'DUPLICATE' | 'RESERVED' | 'ALREADY_HELD' | `REJECTED_${string}` | 'RELEASED' | 'NOT_HELD';

const refOf = (c: SeatCommand): SeatRef => ({
  registration_id: c.registrationId, event_id: c.eventId, activity_id: c.activityId, user_id: c.userId,
});

/** The stored reservation is the truth about which seat a registration holds. */
const refOfHeld = (r: ReservationRow): SeatRef => ({
  registration_id: r.registration_id, event_id: r.event_id, activity_id: r.activity_id, user_id: r.user_id,
});

/**
 * Capacity side of the registration saga (choreography). The subscription service asks for a seat
 * (registration.requested) and gives it back (registration.cancelled / registration.expired); every
 * answer goes out through the outbox in the same transaction as the seat change.
 */
export function createSeatService(deps: ServiceDeps) {
  const run = createUnitOfWork(deps);
  const now = () => deps.now?.() ?? new Date();

  async function reserve(w: Work, c: SeatCommand): Promise<SeatOutcome> {
    const held = await findReservation(w.tx, c.registrationId);
    if (held?.status === 'HELD') {
      // A retried request with a new message id: answer the same thing again, take nothing.
      const activity = (await findActivity(w.tx, held.activity_id))!;
      await w.publish(seatReserved(refOfHeld(held), activity));
      return 'ALREADY_HELD';
    }

    const taken = isUuid(c.activityId) && isUuid(c.eventId) ? await takeSeat(w.tx, c.activityId, c.eventId) : null;
    if (taken) {
      await holdReservation(w.tx, refOf(c));
      await w.publish(seatReserved(refOf(c), taken));
      return 'RESERVED';
    }

    const found = await activityWithEvent(w.tx, c.activityId);
    const reason = seatRejection(found, c.eventId, now());
    await w.publish(seatRejected(refOf(c), reason, found?.activity.event_id === c.eventId ? found.activity : null));
    return `REJECTED_${reason}`;
  }

  async function release(w: Work, c: SeatCommand): Promise<SeatOutcome> {
    const held = await findReservation(w.tx, c.registrationId);
    if (held?.status !== 'HELD') return 'NOT_HELD'; // never got a seat (e.g. waitlisted) or already released
    const activity = await giveBackSeat(w.tx, held.activity_id);
    await releaseReservation(w.tx, held.registration_id);
    await w.publish(seatReleased(refOfHeld(held), activity));
    return 'RELEASED';
  }

  return {
    /** Applies one seat command exactly once, however many times its message is delivered (Idempotent Consumer). */
    handle: (messageId: string, traceId: string | null, c: SeatCommand) =>
      run(c.kind === 'reserve' ? 'SEAT_RESERVE' : 'SEAT_RELEASE', { actor: null, traceId },
        async (w): Promise<SeatOutcome> => {
          w.target.registration_id = c.registrationId;
          w.target.activity_id = c.activityId;
          await lockRegistration(w.tx, c.registrationId);
          const outcome: SeatOutcome = !(await claimMessage(w.tx, messageId)) ? 'DUPLICATE'
            : c.kind === 'reserve' ? await reserve(w, c) : await release(w, c);
          w.target.code = outcome;
          return outcome;
        }),
  };
}

async function activityWithEvent(tx: Queryable, activityId: string) {
  if (!isUuid(activityId)) return null;
  const activity = await findActivity(tx, activityId);
  const event = activity && (await findEvent(tx, activity.event_id));
  return activity && event ? { activity, event } : null;
}

export type SeatService = ReturnType<typeof createSeatService>;
