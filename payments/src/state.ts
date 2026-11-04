// Payment state machine (RN02, RN03). PENDING is the only state that can change; the others are final.

export type Status = 'PENDING' | 'CONFIRMED' | 'REFUSED' | 'EXPIRED' | 'CANCELLED';

export function isFinal(s: Status): boolean {
  return s !== 'PENDING';
}

export type Decision =
  | { kind: 'noop' } // already in the requested state: repeating a request is harmless
  | { kind: 'reject'; reason: string } // final state, request ignored (late confirmation, etc.)
  | { kind: 'apply'; to: Status; reason: string; granted: boolean }; // granted=false: state changed, but not as asked

/**
 * Decides what a request to move a payment to `target` does.
 * A confirmation that arrives after the deadline is never honored: the payment expires instead (RN03),
 * so a late confirmation cannot produce a confirmed registration.
 */
export function decide(current: Status, target: Status, reason: string, expiresAt: Date, now: Date): Decision {
  if (current === target) return { kind: 'noop' };
  if (isFinal(current)) return { kind: 'reject', reason: `payment already ${current}` };
  if (target === 'CONFIRMED' && expiresAt.getTime() <= now.getTime()) {
    return { kind: 'apply', to: 'EXPIRED', reason: 'expired_before_confirmation', granted: false };
  }
  return { kind: 'apply', to: target, reason, granted: true };
}
