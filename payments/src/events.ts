// Pure builders for what the payments service publishes (no I/O, easy to test).

export type PaymentView = {
  payment_id: string;
  registration_id: string;
  user_id: string;
  event_id: string | null;
  amount_minor: number;
  currency: string;
  status: string;
};

export type Outgoing = { key: string; value: string };

const TYPES: Record<string, string> = {
  PENDING: 'PaymentCreated',
  APPROVED: 'PaymentApproved',
  DECLINED: 'PaymentDeclined',
  EXPIRED: 'PaymentExpired',
  CANCELLED: 'PaymentCancelled',
  REFUNDED: 'PaymentRefunded',
};

export function eventTypeFor(status: string): string {
  const t = TYPES[status];
  if (!t) throw new Error(`no event type for status ${status}`);
  return t;
}

/**
 * Flat envelope in Subscription's naming (see subscription/CONTRACTS.md): `message_id` is this message's unique id
 * (consumers dedupe by it); the payment's Events-service event is published as `parent_event_id`.
 * See README, "Events published".
 */
export function buildPaymentEvent(
  p: PaymentView,
  reason: string | null,
  traceId: string | null,
  messageId: string,
  occurredAt: Date,
): Outgoing {
  return {
    key: p.registration_id,
    value: JSON.stringify({
      message_id: messageId,
      schema_version: 1,
      type: eventTypeFor(p.status),
      occurred_at: occurredAt.toISOString(),
      trace_id: traceId,
      payment_id: p.payment_id,
      registration_id: p.registration_id,
      user_id: p.user_id,
      parent_event_id: p.event_id,
      amount_minor: p.amount_minor,
      currency: p.currency,
      status: p.status,
      reason,
    }),
  };
}

/** Human amount from minor units (2 decimals), e.g. `BRL 25.00`. */
export function formatAmount(amountMinor: number, currency: string): string {
  return `${currency} ${(amountMinor / 100).toFixed(2)}`;
}

/** Message for the notifications topic (format in the monorepo README); null when the user needs no notice. */
export function buildNotification(p: PaymentView): Outgoing | null {
  let message: string;
  switch (p.status) {
    case 'APPROVED':
      message = `Pagamento de ${formatAmount(p.amount_minor, p.currency)} confirmado. Sua inscrição está garantida.`;
      break;
    case 'DECLINED':
      message = 'Seu pagamento foi recusado. A vaga reservada foi liberada.';
      break;
    case 'EXPIRED':
      message = 'O prazo do pagamento expirou. A vaga reservada foi liberada.';
      break;
    case 'REFUNDED':
      message = `Seu pagamento de ${formatAmount(p.amount_minor, p.currency)} foi reembolsado.`;
      break;
    default:
      return null; // PENDING and CANCELLED (the user themselves cancelled) are not notified
  }
  return {
    key: p.user_id,
    value: JSON.stringify({
      user_id: p.user_id,
      message,
      payload: { payment_id: p.payment_id, registration_id: p.registration_id, status: p.status },
      payload_type: 'payment',
    }),
  };
}
