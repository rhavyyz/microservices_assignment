import type { OrganizerRequest, Role } from '../api/schemas';

export const ROLE_LABELS: Record<Role, string> = {
  PARTICIPANT: 'Participante',
  ORGANIZER: 'Organizador',
  ADMIN: 'Administrador',
};

export const ORGANIZER_REQUEST_LABELS: Record<OrganizerRequest, string> = {
  NONE: 'Sem pedido',
  PENDING: 'Aguardando aprovação',
  APPROVED: 'Aprovado',
  DENIED: 'Negado',
};

export const ORGANIZER_REQUEST_TONE: Record<OrganizerRequest, 'ok' | 'wait' | 'off'> = {
  NONE: 'off',
  PENDING: 'wait',
  APPROVED: 'ok',
  DENIED: 'off',
};

export function roleLabels(roles: readonly Role[]): string {
  return roles.map((r) => ROLE_LABELS[r]).join(', ') || '—';
}
