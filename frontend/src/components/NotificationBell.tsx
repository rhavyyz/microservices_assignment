import { useEffect, useRef, useState } from 'react';
import { NavLink } from 'react-router';
import { useServices } from '../services/ServicesContext';
import {
  NOTIFICATIONS_CHANGED,
  NOTIFICATION_PUSHED,
  UNREAD_COUNT_LIMIT,
  UNREAD_POLL_MS,
} from './notifications';

/**
 * Link "Notificações" com o contador de não lidas e dono da conexão em tempo real (WebSocket do Gateway): cada
 * notificação nova atualiza o contador e é repassada à página aberta. Como reserva, consulta a cada
 * `UNREAD_POLL_MS` (pausa com a aba oculta) e quando a lista muda. Falhas são silenciosas: o contador é só um aviso e não deve atrapalhar a navegação.
 */
export function NotificationBell() {
  const { notificationsApi, createNotificationsSocket } = useServices();
  const [count, setCount] = useState<number | null>(null);
  // Consulta em andamento: se chega um push no meio, o resultado dela nasceu antes dele e é descartado.
  const inFlight = useRef<AbortController | null>(null);
  // Ids já contados por push: o mesmo aviso entregue duas vezes (reenvio, reconexão) conta uma vez só.
  const pushed = useRef<Set<string>>(new Set());

  useEffect(() => {
    const refresh = () => {
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      notificationsApi
        .list({ status: ['DEFAULT', 'RECEIVED'], limit: UNREAD_COUNT_LIMIT }, controller.signal)
        .then((r) => setCount(r.notifications.length))
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState !== 'hidden') refresh();
    }, UNREAD_POLL_MS);
    window.addEventListener(NOTIFICATIONS_CHANGED, refresh);
    return () => {
      inFlight.current?.abort();
      clearInterval(timer);
      window.removeEventListener(NOTIFICATIONS_CHANGED, refresh);
    };
  }, [notificationsApi]);

  useEffect(() => {
    const socket = createNotificationsSocket({
      onNotification: (n) => {
        if (pushed.current.has(n.id)) return;
        pushed.current.add(n.id);
        inFlight.current?.abort();
        setCount((c) => (c ?? 0) + (n.status === 'SEEN' ? 0 : 1));
        window.dispatchEvent(new CustomEvent(NOTIFICATION_PUSHED, { detail: n }));
      },
    });
    socket.start();
    return () => socket.stop();
  }, [createNotificationsSocket]);

  const label =
    count === null || count === 0
      ? null
      : count >= UNREAD_COUNT_LIMIT
        ? `${UNREAD_COUNT_LIMIT}+`
        : String(count);
  return (
    <NavLink to="/notificacoes">
      Notificações
      {label ? (
        <span className="count-badge" aria-label={`${label} não lidas`}>
          {label}
        </span>
      ) : null}
    </NavLink>
  );
}
