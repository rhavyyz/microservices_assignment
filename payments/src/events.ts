// Pure builders for what the payments service publishes (no I/O, easy to test).

export type PaymentView = {
  payment_id: string;
  registration_id: string;
  user_id: string;
  event_id: string;
  activity_id: string;
  amount: number;
  currency: string;
  status: string;
};

export type Outgoing = { key: string; value: string };

const TYPES: Record<string, string> = {
  PENDING: 'payment.created',
  CONFIRMED: 'payment.confirmed',
  REFUSED: 'payment.refused',
  EXPIRED: 'payment.expired',
  CANCELLED: 'payment.cancelled',
};

export function eventTypeFor(status: string): string {
  const t = TYPES[status];
  if (!t) throw new Error(`no event type for status ${status}`);
  return t;
}

/** Envelope consumed by the reports service (and anyone else): see README, "Events published". */
export function buildPaymentEvent(
  p: PaymentView,
  reason: string | null,
  correlationId: string | null,
  messageId: string,
  occurredAt: Date,
): Outgoing {
  return {
    key: p.registration_id,
    value: JSON.stringify({
      message_id: messageId,
      type: eventTypeFor(p.status),
      version: 1,
      occurred_at: occurredAt.toISOString(),
      correlation_id: correlationId,
      data: {
        payment_id: p.payment_id,
        registration_id: p.registration_id,
        user_id: p.user_id,
        event_id: p.event_id,
        activity_id: p.activity_id,
        amount: p.amount,
        currency: p.currency,
        status: p.status,
        reason,
      },
    }),
  };
}

/** Message for the notifications topic (format in the monorepo README); null when the user needs no notice. */
export function buildNotification(p: PaymentView): Outgoing | null {
  let message: string;
  switch (p.status) {
    case 'CONFIRMED':
      message = `Pagamento de ${p.currency} ${p.amount.toFixed(2)} confirmado. Sua inscrição está garantida.`;
      break;
    case 'REFUSED':
      message = 'Seu pagamento foi recusado. A vaga reservada foi liberada.';
      break;
    case 'EXPIRED':
      message = 'O prazo do pagamento expirou. A vaga reservada foi liberada.';
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
