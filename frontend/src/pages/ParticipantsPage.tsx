import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { describeError, isAbortError, type ErrorDescription } from '../api/errors';
import type { Activity } from '../api/eventsSchemas';
import type { Registration } from '../api/subscriptionSchemas';
import type { UserSummary } from '../api/schemas';
import { formatDateTime, formatPeriod, isUuid, parseApiDate } from '../components/format';
import { STATUS_LABELS, statusTone } from '../components/registration';
import { Alert, Button, LoadingState } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { useServices } from '../services/ServicesContext';
import { NotFoundPage } from './NotFoundPage';

const PAGE_SIZE = 50;

type Result =
  | {
      key: string;
      kind: 'done';
      activity: Activity;
      items: Registration[];
      users: Record<string, UserSummary>;
    }
  | { key: string; kind: 'error'; error: ErrorDescription };

export function ParticipantsPage() {
  const { activityId = '' } = useParams();
  return isUuid(activityId) ? <ParticipantsView activityId={activityId} /> : <NotFoundPage />;
}

/** O check-in vale para inscrição CONFIRMED dentro do horário da atividade; o serviço decide (409 caso contrário). */
function inCheckInWindow(a: Activity, now = new Date()): boolean {
  return (
    a.lifecycle === 'OPEN' &&
    parseApiDate(a.starts_at).getTime() <= now.getTime() &&
    now.getTime() < parseApiDate(a.ends_at).getTime()
  );
}

function ParticipantsView({ activityId }: { activityId: string }) {
  usePageTitle('Participantes');
  const { eventsApi, subscriptionApi, usersApi } = useServices();
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const key = `${activityId}|${page}|${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    (async () => {
      const [activity, items] = await Promise.all([
        eventsApi.getActivity(activityId, signal),
        subscriptionApi.listParticipants(
          activityId,
          { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
          signal,
        ),
      ]);
      // Nome e e-mail vêm do serviço de Usuários (busca por id, só para organizador). Se falhar, mostra o id.
      const ids = [...new Set(items.map((r) => r.user_id))];
      const settled = await Promise.allSettled(
        ids.map((id) => usersApi.searchUsers({ id, size: 1 }, signal)),
      );
      const users: Record<string, UserSummary> = {};
      settled.forEach((s, i) => {
        const found = s.status === 'fulfilled' ? s.value.items[0] : undefined;
        if (found) users[ids[i]!] = found;
      });
      setResult({ key, kind: 'done', activity, items, users });
    })().catch((e: unknown) => {
      if (!isAbortError(e)) setResult({ key, kind: 'error', error: describeError(e) });
    });
    return () => controller.abort();
  }, [eventsApi, subscriptionApi, usersApi, activityId, page, key]);

  const current = result?.key === key ? result : null;
  return (
    <section>
      <p>
        <Link to="/organizador">← Meus eventos</Link>
      </p>
      <h1>Participantes</h1>
      <div aria-live="polite">
        {!current ? <LoadingState label="Carregando participantes…" /> : null}
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
        {current?.kind === 'done' ? (
          <>
            <h2>{current.activity.title}</h2>
            <p>{formatPeriod(current.activity.starts_at, current.activity.ends_at)}</p>
            <p>
              <Link to={`/organizador/eventos/${current.activity.event_id}`}>Voltar ao evento</Link>
            </p>
            {current.items.length === 0 ? (
              <Alert kind="info">
                {page === 0
                  ? 'Ainda não há inscrições nesta atividade.'
                  : 'Não há mais inscrições.'}
              </Alert>
            ) : (
              <>
                <p className="muted">
                  O check-in só é aceito para inscrições confirmadas, durante a atividade. A lista
                  não informa quem já fez check-in; repetir o check-in é seguro.
                </p>
                <ul className="cards">
                  {current.items.map((r) => (
                    <ParticipantRow
                      key={r.id}
                      registration={r}
                      user={current.users[r.user_id]}
                      canCheckIn={inCheckInWindow(current.activity)}
                    />
                  ))}
                </ul>
                <nav className="pager" aria-label="Paginação">
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={page === 0}
                    onClick={() => setPage(page - 1)}
                  >
                    Anterior
                  </Button>
                  <span>Página {page + 1}</span>
                  <Button
                    type="button"
                    variant="secondary"
                    disabled={current.items.length < PAGE_SIZE}
                    onClick={() => setPage(page + 1)}
                  >
                    Próxima
                  </Button>
                </nav>
              </>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}

function ParticipantRow({
  registration: r,
  user,
  canCheckIn,
}: {
  registration: Registration;
  user: UserSummary | undefined;
  canCheckIn: boolean;
}) {
  const { subscriptionApi } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDescription | null>(null);
  const [checkedInAt, setCheckedInAt] = useState<string | null>(null);

  async function checkIn() {
    setBusy(true);
    setError(null);
    try {
      setCheckedInAt((await subscriptionApi.checkIn(r.id)).checked_in_at);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="event-card">
      <h3>{user?.name ?? `Usuário ${r.user_id.slice(0, 8)}`}</h3>
      {user ? <p className="muted">{user.email}</p> : null}
      <p>
        <span className={`badge badge-${statusTone(r.status)}`}>{STATUS_LABELS[r.status]}</span>
      </p>
      <p className="muted">Inscrição feita em {formatDateTime(r.created_at)}</p>
      {checkedInAt ? (
        <Alert kind="success">Presença registrada em {formatDateTime(checkedInAt)}.</Alert>
      ) : null}
      {error ? (
        <Alert kind="error" traceId={error.traceId}>
          {error.message}
        </Alert>
      ) : null}
      {r.status === 'CONFIRMED' && canCheckIn && !checkedInAt ? (
        <Button
          type="button"
          loading={busy}
          loadingText="Registrando…"
          onClick={() => void checkIn()}
        >
          Fazer check-in
        </Button>
      ) : null}
    </li>
  );
}
