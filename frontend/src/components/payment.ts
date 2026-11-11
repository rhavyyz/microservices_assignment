import type { PaymentStatus } from '../api/paymentsSchemas';

export const PAYMENT_LABELS: Record<PaymentStatus, string> = {
  PENDING: 'Aguardando pagamento',
  APPROVED: 'Pagamento aprovado',
  DECLINED: 'Pagamento recusado',
  EXPIRED: 'Prazo expirado',
  CANCELLED: 'Cancelado',
  REFUNDED: 'Reembolsado',
};

/** O que cada estado significa para a pessoa (e o que acontece com a vaga). */
export const PAYMENT_HINTS: Record<PaymentStatus, string> = {
  PENDING: 'Conclua o pagamento antes do prazo para confirmar sua vaga.',
  APPROVED:
    'Seu pagamento foi aprovado. A confirmação da inscrição pode levar alguns instantes para aparecer.',
  DECLINED: 'O pagamento foi recusado e a vaga reservada foi liberada.',
  EXPIRED: 'O prazo do pagamento terminou e a vaga reservada foi liberada.',
  CANCELLED: 'O pagamento foi cancelado junto com a inscrição.',
  REFUNDED: 'O valor foi reembolsado porque a inscrição foi cancelada.',
};

export function paymentTone(status: PaymentStatus): 'ok' | 'wait' | 'off' {
  if (status === 'APPROVED') return 'ok';
  if (status === 'PENDING') return 'wait';
  return 'off';
}

/** Intervalo de atualização enquanto o pagamento está pendente (a aprovação chega de forma assíncrona). */
export const paymentPolling = { intervalMs: 4000 };
