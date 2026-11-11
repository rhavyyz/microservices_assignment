import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { describeError, isAbortError, type ErrorDescription } from '../api/errors';
import type { Activity } from '../api/eventsSchemas';
import { ACTIVE_STATUSES, type Registration } from '../api/subscriptionSchemas';
import { formatDateTime, formatPeriod, formatPrice } from '../components/format';
import { STATUS_HINTS, STATUS_LABELS, statusTone } from '../components/registration';
import { Alert, Button, LoadingState } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { useServices } from '../services/ServicesContext';

const PAGE_SIZE = 20;

type Result =
  | { key: string; kind: 'done'; items: Registration[]; activities: Record<string, Activity> }
  | { key: string; kind: 'error'; error: ErrorDescription };

/** Minhas inscrições. O nome da atividade vem de Eventos; se Eventos falhar, a inscrição aparece mesmo assim. */
export function MyRegistrationsPage() {
  usePageTitle('Minhas inscrições');
  const { subscriptionApi, eventsApi } = useServices();
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const key = `${page}|${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    (async () => {
      const items = await subscriptionApi.listMine(
        { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
        signal,
      );
      const ids = [...new Set(items.map((r) => r.activity_id))];
      const settled = await Promise.allSettled(ids.map((id) => eventsApi.getActivity(id, signal)));
      const activities: Record<string, Activity> = {};
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled') activities[ids[i]!] = s.value;
      });
      setResult({ key, kind: 'done', items, activities });
    })().catch((e: unknown) => {
      if (!isAbortError(e)) setResult({ key, kind: 'error', error: describeError(e) });
    });
    return () => controller.abort();
  }, [subscriptionApi, eventsApi, page, key]);

  function replace(updated: Registration) {
    setResult((r) =>
      r && r.kind === 'done'
        ? { ...r, items: r.items.map((x) => (x.id === updated.id ? updated : x)) }
        : r,
    );
  }

  const current = result?.key === key ? result : null;
  return (
    <section>
      <h1>Minhas inscrições</h1>
      <div aria-live="polite">
        {!current ? <LoadingState label="Carregando inscrições…" /> : null}
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
            {page === 0 ? 'Você ainda não tem inscrições.' : 'Não há mais inscrições.'}{' '}
            <Link to="/eventos">Explorar eventos</Link>
          </Alert>
        ) : null}
        {current?.kind === 'done' && current.items.length > 0 ? (
          <>
            <ul className="cards">
              {current.items.map((r) => (
                <RegistrationRow
                  key={r.id}
                  registration={r}
                  activity={current.activities[r.activity_id]}
                  onChange={replace}
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
        ) : null}
      </div>
    </section>
  );
}

function RegistrationRow({
  registration: r,
  activity,
  onChange,
}: {
  registration: Registration;
  activity: Activity | undefined;
  onChange: (r: Registration) => void;
}) {
  const { subscriptionApi, paymentsApi } = useServices();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ErrorDescription | null>(null);

  async function run(action: () => Promise<Registration>) {
    setBusy(true);
    setError(null);
    try {
      onChange(await action());
      setConfirming(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  /** Idempotente no serviço: se já existe pagamento, devolve o mesmo e a pessoa só retoma a tela. */
  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const payment = await paymentsApi.createPayment(r.id);
      void navigate(`/pagamentos/${payment.payment_id}`);
    } catch (e) {
      setError(describeError(e));
      setBusy(false);
    }
  }

  const eventId = r.parent_event_id ?? activity?.event_id;
  const active = ACTIVE_STATUSES.includes(r.status);
  const hint = STATUS_HINTS[r.status];
  const showsDeadline = (r.status === 'OFFERED' || r.status === 'PENDING_PAYMENT') && r.expires_at;

  return (
    <li className="event-card">
      <h2>{activity?.title ?? `Atividade ${r.activity_id.slice(0, 8)}`}</h2>
      <p>
        <span className={`badge badge-${statusTone(r.status)}`}>{STATUS_LABELS[r.status]}</span>
      </p>
      {activity ? <p>{formatPeriod(activity.starts_at, activity.ends_at)}</p> : null}
      {activity?.location ? <p className="muted">{activity.location}</p> : null}
      <p>{formatPrice(r.amount_minor, r.currency)}</p>
      {hint ? <p className="muted">{hint}</p> : null}
      {showsDeadline ? <p>Prazo: {formatDateTime(r.expires_at!)}</p> : null}
      <p className="muted">Inscrição feita em {formatDateTime(r.created_at)}</p>
      {eventId ? (
        <p>
          <Link to={`/eventos/${eventId}`}>Ver evento</Link>
        </p>
      ) : null}
      {error ? (
        <Alert kind="error" traceId={error.traceId}>
          {error.message}
        </Alert>
      ) : null}
      <div className="row-actions">
        {r.status === 'PENDING_PAYMENT' ? (
          <Button
            type="button"
            loading={busy}
            loadingText="Abrindo pagamento…"
            onClick={() => void pay()}
          >
            Pagar
          </Button>
        ) : null}
        {r.status === 'OFFERED' ? (
          <Button
            type="button"
            loading={busy}
            loadingText="Aceitando…"
            onClick={() => void run(() => subscriptionApi.acceptOffer(r.id))}
          >
            Aceitar oferta
          </Button>
        ) : null}
        {active && !confirming ? (
          <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
            Cancelar inscrição
          </Button>
        ) : null}
        {active && confirming ? (
          <>
            <Button
              type="button"
              loading={busy}
              loadingText="Cancelando…"
              onClick={() => void run(() => subscriptionApi.cancelRegistration(r.id))}
            >
              Confirmar cancelamento
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirming(false)}
            >
              Voltar
            </Button>
          </>
        ) : null}
      </div>
    </li>
  );
}
