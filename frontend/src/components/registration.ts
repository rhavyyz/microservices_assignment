import type { RegistrationStatus } from '../api/subscriptionSchemas';

export const STATUS_LABELS: Record<RegistrationStatus, string> = {
  WAITLISTED: 'Na lista de espera',
  OFFERED: 'Vaga oferecida',
  PENDING_PAYMENT: 'Aguardando pagamento',
  CONFIRMED: 'Confirmada',
  CANCELLED: 'Cancelada',
  EXPIRED: 'Expirada',
  REJECTED: 'Recusada',
};

export const STATUS_HINTS: Partial<Record<RegistrationStatus, string>> = {
  WAITLISTED: 'Você será avisado se uma vaga for liberada.',
  OFFERED: 'Uma vaga foi liberada para você. Aceite a oferta antes de ela expirar.',
  PENDING_PAYMENT: 'A vaga está reservada até o prazo; conclua o pagamento para confirmar.',
};

/** Só para estilizar a etiqueta de status; o texto vem de STATUS_LABELS. */
export function statusTone(status: RegistrationStatus): 'ok' | 'wait' | 'off' {
  if (status === 'CONFIRMED') return 'ok';
  if (status === 'CANCELLED' || status === 'EXPIRED' || status === 'REJECTED') return 'off';
  return 'wait';
}
