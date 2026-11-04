import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { describeError, isAbortError, type ErrorDescription } from '../api/errors';
import type { EventPage } from '../api/eventsSchemas';
import { formatPeriod } from '../components/format';
import { EVENT_STATUS_LABELS, EVENT_STATUS_TONE } from '../components/organizerMeta';
import { Alert, Button, LoadingState } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { useServices } from '../services/ServicesContext';

const PAGE_SIZE = 20;

type Result =
  | { key: string; kind: 'done'; page: EventPage }
  | { key: string; kind: 'error'; error: ErrorDescription };

/** Eventos do organizador (rascunhos incluídos), vindos de GET /me/events. */
export function OrganizerEventsPage() {
  usePageTitle('Meus eventos');
  const { eventsApi } = useServices();
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const key = `${page}|${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    eventsApi
      .listMyEvents({ limit: PAGE_SIZE, offset: page * PAGE_SIZE }, controller.signal)
      .then((p) => setResult({ key, kind: 'done', page: p }))
      .catch((e: unknown) => {
        if (!isAbortError(e)) setResult({ key, kind: 'error', error: describeError(e) });
      });
    return () => controller.abort();
  }, [eventsApi, page, key]);

  const current = result?.key === key ? result : null;
  return (
    <section>
      <h1>Meus eventos</h1>
      <p>
        <Link className="btn btn-primary" to="/organizador/novo">
          Novo evento
        </Link>
      </p>
      <div aria-live="polite">
        {!current ? <LoadingState label="Carregando seus eventos…" /> : null}
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
        {current?.kind === 'done' && current.page.items.length === 0 ? (
          <Alert kind="info">
            {page === 0 ? 'Você ainda não criou eventos.' : 'Não há mais eventos.'}
          </Alert>
        ) : null}
        {current?.kind === 'done' && current.page.items.length > 0 ? (
          <>
            <ul className="cards">
              {current.page.items.map((e) => (
                <li key={e.event_id} className="event-card">
                  <h2>{e.title}</h2>
                  <p>
                    <span className={`badge badge-${EVENT_STATUS_TONE[e.status]}`}>
                      {EVENT_STATUS_LABELS[e.status]}
                    </span>
                  </p>
                  <p>{formatPeriod(e.starts_at, e.ends_at)}</p>
                  {e.location ? <p className="muted">{e.location}</p> : null}
                  <p>
                    <Link to={`/organizador/eventos/${e.event_id}`}>Gerenciar</Link>
                    {e.status !== 'DRAFT' ? (
                      <>
                        {' · '}
                        <Link to={`/organizador/eventos/${e.event_id}/relatorio`}>Relatório</Link>
                      </>
                    ) : null}
                  </p>
                </li>
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
                disabled={(page + 1) * PAGE_SIZE >= current.page.total}
                onClick={() => setPage(page + 1)}
              >
                Próxima
              </Button>
            </nav>
          </>
        ) : null}
      </div>
    </section>
  );
}
