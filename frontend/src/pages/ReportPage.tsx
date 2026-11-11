import { useEffect, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { describeError, isAbortError, toApiError, type ErrorDescription } from '../api/errors';
import type { ActivityReportPage, Money, Summary } from '../api/reportsSchemas';
import { formatMoney, formatPeriod, formatRate, isUuid } from '../components/format';
import { EVENT_STATUS_LABELS } from '../components/organizerMeta';
import { Alert, Button, LoadingState } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { useServices } from '../services/ServicesContext';
import type { EventStatus } from '../api/eventsSchemas';
import { NotFoundPage } from './NotFoundPage';

const PAGE_SIZE = 20;

type SummaryState =
  | { key: string; kind: 'done'; summary: Summary }
  | { key: string; kind: 'error'; error: ErrorDescription; notFound: boolean };
type ActivitiesState =
  | { key: string; kind: 'done'; page: ActivityReportPage }
  | { key: string; kind: 'error'; error: ErrorDescription };

export function ReportPage() {
  const { eventId = '' } = useParams();
  return isUuid(eventId) ? <ReportView eventId={eventId} /> : <NotFoundPage />;
}

/** Dinheiro por moeda: nunca somado entre moedas. */
function MoneyList({ items, empty }: { items: Money[]; empty: string }) {
  if (items.length === 0) return <>{empty}</>;
  return <>{items.map((m) => formatMoney(m.amount_minor, m.currency)).join(' · ')}</>;
}

function Metric({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="metric">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ReportView({ eventId }: { eventId: string }) {
  usePageTitle('Relatório do evento');
  const { reportsApi } = useServices();
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [summary, setSummary] = useState<SummaryState | null>(null);
  const [activities, setActivities] = useState<ActivitiesState | null>(null);
  const summaryKey = `${eventId}|${attempt}`;
  const activitiesKey = `${eventId}|${page}|${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    reportsApi
      .getSummary(eventId, controller.signal)
      .then((s) => setSummary({ key: summaryKey, kind: 'done', summary: s }))
      .catch((e: unknown) => {
        if (isAbortError(e)) return;
        const err = toApiError(e);
        setSummary({
          key: summaryKey,
          kind: 'error',
          error: describeError(err),
          notFound: err.status === 404,
        });
      });
    return () => controller.abort();
  }, [reportsApi, eventId, summaryKey]);

  useEffect(() => {
    const controller = new AbortController();
    reportsApi
      .listActivities(eventId, { limit: PAGE_SIZE, offset: page * PAGE_SIZE }, controller.signal)
      .then((p) => setActivities({ key: activitiesKey, kind: 'done', page: p }))
      .catch((e: unknown) => {
        if (!isAbortError(e))
          setActivities({ key: activitiesKey, kind: 'error', error: describeError(e) });
      });
    return () => controller.abort();
  }, [reportsApi, eventId, page, activitiesKey]);

  const s = summary?.key === summaryKey ? summary : null;
  const a = activities?.key === activitiesKey ? activities : null;

  if (!s) return <LoadingState label="Carregando relatório…" />;
  if (s.kind === 'error') {
    if (s.notFound) return <NotFoundPage />;
    return (
      <section>
        <Alert kind="error" traceId={s.error.traceId}>
          {s.error.message}
        </Alert>
        <Button type="button" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
          Tentar novamente
        </Button>
      </section>
    );
  }

  const {
    event,
    registrations: r,
    payments: p,
    occupancy: o,
    attendance: at,
    activities: lc,
  } = s.summary;
  const statusLabel = EVENT_STATUS_LABELS[event.status as EventStatus] ?? event.status;
  return (
    <section>
      <p>
        <Link to={`/organizador/eventos/${event.event_id}`}>← Gerenciar evento</Link>
      </p>
      <h1>Relatório: {event.name ?? 'Evento sem nome'}</h1>
      <p>
        <span className="badge badge-off">{statusLabel}</span>
        {event.starts_at && event.ends_at ? ` ${formatPeriod(event.starts_at, event.ends_at)}` : ''}
      </p>
      <p className="muted">
        Os números são calculados a partir dos eventos dos serviços e podem levar alguns instantes
        para refletir as últimas mudanças.{' '}
        <Button type="button" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
          Atualizar
        </Button>
      </p>

      <h2>Inscrições</h2>
      <dl className="metrics" aria-label="Inscrições">
        <Metric label="Total">{r.total}</Metric>
        <Metric label="Confirmadas">{r.confirmed}</Metric>
        <Metric label="Aguardando pagamento">{r.pending_payment}</Metric>
        <Metric label="Com oferta de vaga">{r.offered}</Metric>
        <Metric label="Na lista de espera">{r.waitlisted}</Metric>
        <Metric label="Canceladas">{r.cancelled}</Metric>
        <Metric label="Expiradas">{r.expired}</Metric>
        <Metric label="Recusadas">{r.rejected}</Metric>
      </dl>

      <h2>Pagamentos</h2>
      <dl className="metrics" aria-label="Pagamentos">
        <Metric label="Aprovados">{p.approved}</Metric>
        <Metric label="Pendentes">{p.pending}</Metric>
        <Metric label="Recusados">{p.declined}</Metric>
        <Metric label="Expirados">{p.expired}</Metric>
        <Metric label="Cancelados">{p.cancelled}</Metric>
        <Metric label="Reembolsados">{p.refunded_count}</Metric>
        <Metric label="Receita">
          <MoneyList items={p.revenue} empty="Nenhuma receita" />
        </Metric>
        <Metric label="Valor reembolsado">
          <MoneyList items={p.refunded} empty="Nenhum reembolso" />
        </Metric>
      </dl>

      <h2>Ocupação</h2>
      <dl className="metrics" aria-label="Ocupação">
        <Metric label="Vagas ocupadas">
          {o.occupied} de {o.capacity}
        </Metric>
        <Metric label="Taxa de ocupação">{formatRate(o.rate)}</Metric>
      </dl>
      <p className="muted">
        Ocupadas = inscrições confirmadas, aguardando pagamento ou com oferta de vaga. Atividades
        canceladas não entram na capacidade.
      </p>

      <h2>Presença</h2>
      <dl className="metrics" aria-label="Presença">
        <Metric label="Inscrições confirmadas">{at.confirmed}</Metric>
        <Metric label="Check-ins">{at.checkins}</Metric>
        <Metric label="Taxa de presença">{formatRate(at.rate)}</Metric>
        <Metric label="Aptos a certificado">{at.certificate_eligible}</Metric>
        <Metric label="Taxa de aptos entre quem compareceu">
          {formatRate(at.certificate_eligible_rate)}
        </Metric>
      </dl>

      <h2>Atividades</h2>
      <p>
        {lc.open} aberta(s) · {lc.ended} encerrada(s) · {lc.cancelled} cancelada(s)
      </p>
      {!a ? <LoadingState label="Carregando atividades…" /> : null}
      {a?.kind === 'error' ? (
        <>
          <Alert kind="error" traceId={a.error.traceId}>
            {a.error.message}
          </Alert>
          <Button type="button" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
            Tentar novamente
          </Button>
        </>
      ) : null}
      {a?.kind === 'done' && a.page.items.length === 0 ? (
        <Alert kind="info">
          {page === 0 ? 'Este evento ainda não tem atividades.' : 'Não há mais atividades.'}
        </Alert>
      ) : null}
      {a?.kind === 'done' && a.page.items.length > 0 ? (
        <>
          <div className="table-scroll">
            <table>
              <caption className="sr-only">Indicadores por atividade</caption>
              <thead>
                <tr>
                  <th scope="col">Atividade</th>
                  <th scope="col">Ocupação</th>
                  <th scope="col">Confirmadas</th>
                  <th scope="col">Lista de espera</th>
                  <th scope="col">Pagamentos aprovados</th>
                  <th scope="col">Receita</th>
                  <th scope="col">Check-ins</th>
                  <th scope="col">Presença</th>
                </tr>
              </thead>
              <tbody>
                {a.page.items.map((x) => (
                  <tr key={x.activity_id}>
                    <th scope="row">
                      {x.name ?? 'Atividade sem nome'}
                      {x.lifecycle !== 'OPEN' ? (
                        <span className="muted">
                          {' '}
                          ({x.lifecycle === 'ENDED' ? 'encerrada' : 'cancelada'})
                        </span>
                      ) : null}
                    </th>
                    <td>
                      {x.occupied}
                      {x.capacity !== null ? ` de ${x.capacity}` : ''} (
                      {formatRate(x.occupancy_rate)})
                    </td>
                    <td>{x.confirmed}</td>
                    <td>{x.waitlisted}</td>
                    <td>{x.payments_approved}</td>
                    <td>
                      <MoneyList items={x.revenue} empty="—" />
                    </td>
                    <td>{x.checkins}</td>
                    <td>{formatRate(x.attendance_rate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pager" aria-label="Paginação das atividades">
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
              disabled={(page + 1) * PAGE_SIZE >= a.page.total}
              onClick={() => setPage(page + 1)}
            >
              Próxima
            </Button>
          </nav>
        </>
      ) : null}
    </section>
  );
}
