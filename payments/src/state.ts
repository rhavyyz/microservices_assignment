// Payment state machine (RN02, RN03). PENDING moves to any of APPROVED / DECLINED / EXPIRED / CANCELLED;
// APPROVED can only move to REFUNDED; every other state is final.

export type Status = 'PENDING' | 'APPROVED' | 'DECLINED' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';

/** No further transition is possible. APPROVED is not final: it can still be REFUNDED. */
export function isFinal(s: Status): boolean {
  return s !== 'PENDING' && s !== 'APPROVED';
}

export type Decision =
  | { kind: 'noop' } // already in the requested state: repeating a request is harmless
  | { kind: 'reject'; reason: string } // final state, request ignored (late approval, etc.)
  | { kind: 'apply'; to: Status; reason: string; granted: boolean }; // granted=false: state changed, but not as asked

/**
 * Decides what a request to move a payment to `target` does.
 * An approval that arrives after the deadline is never honored: the payment expires instead (RN03),
 * so a late approval cannot produce a confirmed registration.
 */
export function decide(current: Status, target: Status, reason: string, expiresAt: Date, now: Date): Decision {
  if (current === target) return { kind: 'noop' };
  if (target === 'REFUNDED') {
    // A refund only ever applies to an approved payment.
    return current === 'APPROVED'
      ? { kind: 'apply', to: 'REFUNDED', reason, granted: true }
      : { kind: 'reject', reason: `payment ${current} cannot be refunded` };
  }
  if (isFinal(current) || current === 'APPROVED') return { kind: 'reject', reason: `payment already ${current}` };
  if (target === 'APPROVED' && expiresAt.getTime() <= now.getTime()) {
    return { kind: 'apply', to: 'EXPIRED', reason: 'expired_before_confirmation', granted: false };
  }
  return { kind: 'apply', to: target, reason, granted: true };
}
