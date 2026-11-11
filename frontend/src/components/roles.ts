import type { Role } from '../api/schemas';

export const ROLE_LABELS: Record<Role, string> = {
  PARTICIPANT: 'Participante',
  ORGANIZER: 'Organizador',
};

export function roleLabels(roles: readonly Role[]): string {
  return roles.map((r) => ROLE_LABELS[r]).join(', ') || '—';
}
