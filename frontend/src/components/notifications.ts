import type { AppNotification } from '../api/notificationsSchemas';
import { isUuid } from './format';

/** Disparado na janela quando a lista muda, para o contador do menu atualizar sem esperar o próximo ciclo. */
export const NOTIFICATIONS_CHANGED = 'eventhub:notifications-changed';
/** Notificação nova recebida em tempo real (`detail` = a notificação). */
export const NOTIFICATION_PUSHED = 'eventhub:notification-pushed';
/** Reserva: consulta periódica do contador, caso o WebSocket esteja fora do ar. */
export const UNREAD_POLL_MS = 30_000;
/** O contador consulta até este limite de notificações não lidas (máximo do serviço). */
export const UNREAD_COUNT_LIMIT = 100;

/**
 * Para onde a notificação leva. Só destinos internos conhecidos, montados a partir do payload: o `redirect_url`
 * que o serviço guarda não é usado (ninguém o produz hoje, e um endereço vindo de fora não deve virar link).
 * Pagamentos: `payload_type: "payment"` com `payment_id`. Inscrições: `payload_type` = tipo do evento de domínio.
 */
export function notificationTarget(n: AppNotification): string | null {
  if (n.payload_type === 'payment') {
    const id = n.payload?.['payment_id'];
    return typeof id === 'string' && isUuid(id) ? `/pagamentos/${id}` : null;
  }
  if (n.payload_type && /^(Registration|Waitlist)[A-Za-z]*$/.test(n.payload_type))
    return '/inscricoes';
  return null;
}
