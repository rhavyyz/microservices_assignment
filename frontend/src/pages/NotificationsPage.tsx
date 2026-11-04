import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { describeError, isAbortError, type ErrorDescription } from '../api/errors';
import { isUnread, type AppNotification } from '../api/notificationsSchemas';
import { formatDateTime } from '../components/format';
import {
  NOTIFICATIONS_CHANGED,
  NOTIFICATION_PUSHED,
  notificationTarget,
} from '../components/notifications';
import { Alert, Button, LoadingState } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { useServices } from '../services/ServicesContext';

const PAGE_SIZE = 20;

type Filter = 'all' | 'unread';
type State =
  | { key: string; kind: 'done'; items: AppNotification[]; next: string | null }
  | { key: string; kind: 'error'; error: ErrorDescription };

export function NotificationsPage() {
  usePageTitle('Notificações');
  const { notificationsApi } = useServices();
  const [filter, setFilter] = useState<Filter>('all');
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<State | null>(null);
  const [more, setMore] = useState<{ busy: boolean; error: ErrorDescription | null }>({
    busy: false,
    error: null,
  });
  const [actionError, setActionError] = useState<ErrorDescription | null>(null);
  const [busy, setBusy] = useState(false);
  const key = `${filter}|${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    notificationsApi
      .list(
        { status: filter === 'unread' ? ['DEFAULT', 'RECEIVED'] : undefined, limit: PAGE_SIZE },
        controller.signal,
      )
      .then((r) =>
        setState({ key, kind: 'done', items: r.notifications, next: r.next_base_notification_id }),
      )
      .catch((e: unknown) => {
        if (!isAbortError(e)) setState({ key, kind: 'error', error: describeError(e) });
      });
    return () => controller.abort();
  }, [notificationsApi, filter, key]);

  const current = state?.key === key ? state : null;

  // Notificação nova em tempo real: entra no topo (sem duplicar) e cabe nos dois filtros (é não lida).
  useEffect(() => {
    const onPush = (ev: Event) => {
      const n = (ev as CustomEvent<AppNotification>).detail;
      setState((s) =>
        s && s.kind === 'done' && !s.items.some((x) => x.id === n.id)
          ? { ...s, items: [n, ...s.items] }
          : s,
      );
    };
    window.addEventListener(NOTIFICATION_PUSHED, onPush);
    return () => window.removeEventListener(NOTIFICATION_PUSHED, onPush);
  }, []);

  async function loadMore() {
    if (current?.kind !== 'done' || !current.next) return;
    setMore({ busy: true, error: null });
    try {
      const r = await notificationsApi.list({
        status: filter === 'unread' ? ['DEFAULT', 'RECEIVED'] : undefined,
        limit: PAGE_SIZE,
        base: current.next,
      });
      setState({
        key,
        kind: 'done',
        items: [...current.items, ...r.notifications],
        next: r.next_base_notification_id,
      });
      setMore({ busy: false, error: null });
    } catch (e) {
      setMore({ busy: false, error: describeError(e) });
    }
  }

  async function markRead(ids: string[]) {
    if (current?.kind !== 'done' || ids.length === 0) return;
    setBusy(true);
    setActionError(null);
    try {
      const res = await notificationsApi.updateStatus(
        ids.slice(0, 100).map((id) => ({ id, status: 'SEEN' as const })),
      );
      const failed = new Set(Object.keys(res.errors));
      const done = new Set(ids.filter((id) => !failed.has(id)));
      setState({
        ...current,
        items: current.items.map((n) => (done.has(n.id) ? { ...n, status: 'SEEN' as const } : n)),
      });
      window.dispatchEvent(new Event(NOTIFICATIONS_CHANGED));
      if (failed.size > 0) {
        setActionError({
          message: `${failed.size} notificação(ões) não puderam ser atualizadas. Tente novamente.`,
          traceId: undefined,
        });
      }
    } catch (e) {
      setActionError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  const unreadIds = current?.kind === 'done' ? current.items.filter(isUnread).map((n) => n.id) : [];
  return (
    <section>
      <h1>Notificações</h1>
      <div className="row-actions" role="group" aria-label="Filtro">
        <Button
          type="button"
          variant={filter === 'all' ? 'primary' : 'secondary'}
          aria-pressed={filter === 'all'}
          onClick={() => setFilter('all')}
        >
          Todas
        </Button>
        <Button
          type="button"
          variant={filter === 'unread' ? 'primary' : 'secondary'}
          aria-pressed={filter === 'unread'}
          onClick={() => setFilter('unread')}
        >
          Não lidas
        </Button>
        {unreadIds.length > 0 ? (
          <Button
            type="button"
            variant="secondary"
            loading={busy}
            loadingText="Marcando…"
            onClick={() => void markRead(unreadIds)}
          >
            Marcar todas como lidas
          </Button>
        ) : null}
      </div>
      {actionError ? (
        <Alert kind="error" traceId={actionError.traceId}>
          {actionError.message}
        </Alert>
      ) : null}
      <div aria-live="polite">
        {!current ? <LoadingState label="Carregando notificações…" /> : null}
        {current?.kind === 'error' ? (
          <>
            <Alert kind="error" traceId={current.error.traceId}>
              {current.error.message}
            </Alert>
            <Button type="button" variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
              Tentar novamente
            </Button>
          </>
        ) : null}
        {current?.kind === 'done' && current.items.length === 0 ? (
          <Alert kind="info">
            {filter === 'unread'
              ? 'Você não tem notificações novas.'
              : 'Você ainda não tem notificações.'}
          </Alert>
        ) : null}
        {current?.kind === 'done' && current.items.length > 0 ? (
          <>
            <ul className="cards">
              {current.items.map((n) => {
                const target = notificationTarget(n);
                return (
                  <li key={n.id} className="event-card">
                    <p>
                      <span className={`badge badge-${isUnread(n) ? 'wait' : 'off'}`}>
                        {isUnread(n) ? 'Nova' : 'Lida'}
                      </span>
                    </p>
                    <p>{n.message}</p>
                    <p className="muted">{formatDateTime(n.created_at)}</p>
                    <div className="row-actions">
                      {target ? <Link to={target}>Ver detalhes</Link> : null}
                      {isUnread(n) ? (
                        <Button
                          type="button"
                          variant="secondary"
                          disabled={busy}
                          onClick={() => void markRead([n.id])}
                        >
                          Marcar como lida
                        </Button>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
            {more.error ? (
              <Alert kind="error" traceId={more.error.traceId}>
                {more.error.message}
              </Alert>
            ) : null}
            {current.next ? (
              <Button
                type="button"
                variant="secondary"
                loading={more.busy}
                loadingText="Carregando…"
                onClick={() => void loadMore()}
              >
                Carregar mais
              </Button>
            ) : null}
          </>
        ) : null}
      </div>
    </section>
  );
}
