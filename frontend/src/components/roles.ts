import type { Role } from '../api/schemas';

export const ROLE_LABELS: Record<Role, string> = {
  PARTICIPANT: 'Participante',
  ORGANIZER: 'Organizador',
};

export function roleLabels(roles: readonly Role[]): string {
  return roles.map((r) => ROLE_LABELS[r]).join(', ') || '—';
}

const dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short' });

export function formatDateTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFormat.format(d);
}
