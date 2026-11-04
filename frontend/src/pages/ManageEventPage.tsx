import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { describeError, isAbortError, toApiError, type ErrorDescription } from '../api/errors';
import type { Activity, EventDetail } from '../api/eventsSchemas';
import { formatPeriod, formatPrice, hasEnded, isUuid } from '../components/format';
import { ActivityFormFields, EventFormFields } from '../components/organizer';
import { EVENT_STATUS_LABELS, EVENT_STATUS_TONE } from '../components/organizerMeta';
import { Alert, Button, LoadingState } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { toActivityInput, toEventInput } from '../schemas/organizer';
import { useServices } from '../services/ServicesContext';
import { NotFoundPage } from './NotFoundPage';

type Load =
  | { key: string; kind: 'done'; event: EventDetail }
  | { key: string; kind: 'error'; error: ErrorDescription; notFound: boolean };

export function ManageEventPage() {
  const { eventId = '' } = useParams();
  return isUuid(eventId) ? <ManageEventView eventId={eventId} /> : <NotFoundPage />;
}

function ManageEventView({ eventId }: { eventId: string }) {
  const { eventsApi } = useServices();
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load | null>(null);
  const key = `${eventId}|${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    eventsApi
      .getEvent(eventId, controller.signal, { auth: true })
      .then((event) => setLoad({ key, kind: 'done', event }))
      .catch((e: unknown) => {
        if (isAbortError(e)) return;
        const error = describeError(e);
        const status = toApiError(e).status;
        setLoad({ key, kind: 'error', error, notFound: status === 404 });
      });
    return () => controller.abort();
  }, [eventsApi, eventId, key]);

  const current = load?.key === key ? load : null;
  if (!current) return <LoadingState label="Carregando evento…" />;
  if (current.kind === 'error') {
    if (current.notFound) return <NotFoundPage />;
    return (
      <section>
        <Alert kind="error" traceId={current.error.traceId}>
          {current.error.message}
        </Alert>
        <Button type="button" variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
          Tentar novamente
        </Button>
      </section>
    );
  }
  return (
    <ManageEvent
      event={current.event}
      onChange={(event) => setLoad({ key, kind: 'done', event })}
    />
  );
}

function ManageEvent({
  event,
  onChange,
}: {
  event: EventDetail;
  onChange: (e: EventDetail) => void;
}) {
  usePageTitle(`Gerenciar: ${event.title}`);
  const { eventsApi } = useServices();
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDescription | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const draft = event.status === 'DRAFT';
  const cancelled = event.status === 'CANCELLED';

  async function status(action: () => Promise<unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      const fresh = await eventsApi.getEvent(event.event_id, undefined, { auth: true });
      onChange(fresh);
      setConfirmCancel(false);
      setNotice(done);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  function replaceActivity(updated: Activity) {
    onChange({
      ...event,
      activities: event.activities.map((a) =>
        a.activity_id === updated.activity_id ? updated : a,
      ),
    });
  }

  return (
    <section>
      <p>
        <Link to="/organizador">← Meus eventos</Link>
      </p>
      <h1>{event.title}</h1>
      <p>
        <span className={`badge badge-${EVENT_STATUS_TONE[event.status]}`}>
          {EVENT_STATUS_LABELS[event.status]}
        </span>
      </p>
      <p>{formatPeriod(event.starts_at, event.ends_at)}</p>
      {event.location ? <p className="muted">{event.location}</p> : null}
      {event.status === 'PUBLISHED' ? (
        <p>
          <Link to={`/eventos/${event.event_id}`}>Ver como participante</Link>
        </p>
      ) : null}
      {!draft ? (
        <p>
          <Link to={`/organizador/eventos/${event.event_id}/relatorio`}>Ver relatório</Link>
        </p>
      ) : null}

      {notice ? <Alert kind="success">{notice}</Alert> : null}
      {error ? (
        <Alert kind="error" traceId={error.traceId}>
          {error.message}
        </Alert>
      ) : null}

      {!cancelled ? (
        <div className="row-actions">
          {!editing ? (
            <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
              Editar dados do evento
            </Button>
          ) : null}
          {draft ? (
            <Button
              type="button"
              loading={busy}
              loadingText="Publicando…"
              onClick={() =>
                void status(() => eventsApi.publishEvent(event.event_id), 'Evento publicado.')
              }
            >
              Publicar evento
            </Button>
          ) : null}
          {!confirmCancel ? (
            <Button type="button" variant="secondary" onClick={() => setConfirmCancel(true)}>
              Cancelar evento
            </Button>
          ) : null}
        </div>
      ) : null}
      {draft && event.activities.length === 0 ? (
        <p className="muted">Adicione ao menos uma atividade para poder publicar.</p>
      ) : null}
      {confirmCancel ? (
        <Alert kind="info">
          Cancelar é definitivo: as inscrições das atividades serão canceladas.
          <span className="row-actions">
            <Button
              type="button"
              loading={busy}
              loadingText="Cancelando…"
              onClick={() =>
                void status(() => eventsApi.cancelEvent(event.event_id), 'Evento cancelado.')
              }
            >
              Confirmar cancelamento do evento
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirmCancel(false)}
            >
              Voltar
            </Button>
          </span>
        </Alert>
      ) : null}

      {editing ? (
        <div className="card">
          <h2>Editar evento</h2>
          <EventFormFields
            initial={event}
            submitLabel="Salvar alterações"
            loadingText="Salvando…"
            onCancel={() => setEditing(false)}
            onSubmit={async (values) => {
              const saved = await eventsApi.updateEvent(event.event_id, toEventInput(values));
              onChange({ ...event, ...saved });
              setEditing(false);
              setNotice('Dados do evento atualizados.');
            }}
          />
        </div>
      ) : null}

      <h2>Atividades</h2>
      {event.activities.length === 0 ? <Alert kind="info">Nenhuma atividade ainda.</Alert> : null}
      <ul className="cards">
        {event.activities.map((a) => (
          <ActivityRow
            key={a.activity_id}
            activity={a}
            event={event}
            onChange={replaceActivity}
            onRemoved={() =>
              onChange({
                ...event,
                activities: event.activities.filter((x) => x.activity_id !== a.activity_id),
              })
            }
          />
        ))}
      </ul>

      {!cancelled && !adding ? (
        <Button type="button" variant="secondary" onClick={() => setAdding(true)}>
          Adicionar atividade
        </Button>
      ) : null}
      {adding ? (
        <div className="card">
          <h3>Nova atividade</h3>
          <ActivityFormFields
            submitLabel="Adicionar atividade"
            loadingText="Adicionando…"
            onCancel={() => setAdding(false)}
            onSubmit={async (values) => {
              const created = await eventsApi.addActivity(event.event_id, toActivityInput(values));
              onChange({ ...event, activities: [...event.activities, created] });
              setAdding(false);
              setNotice('Atividade adicionada.');
            }}
          />
        </div>
      ) : null}
    </section>
  );
}

const LIFECYCLE_LABELS = { OPEN: 'Aberta', ENDED: 'Encerrada', CANCELLED: 'Cancelada' } as const;

function ActivityRow({
  activity: a,
  event,
  onChange,
  onRemoved,
}: {
  activity: Activity;
  event: EventDetail;
  onChange: (a: Activity) => void;
  onRemoved: () => void;
}) {
  const { eventsApi } = useServices();
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDescription | null>(null);

  const draft = event.status === 'DRAFT';
  const open = a.lifecycle === 'OPEN';
  const canEnd = open && event.status === 'PUBLISHED' && hasEnded(a.ends_at);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="event-card">
      <h3>{a.title}</h3>
      <p>
        <span className={`badge badge-${open ? 'ok' : 'off'}`}>
          {LIFECYCLE_LABELS[a.lifecycle]}
        </span>
      </p>
      <p>{formatPeriod(a.starts_at, a.ends_at)}</p>
      {a.location ? <p className="muted">{a.location}</p> : null}
      <p>
        {formatPrice(a.amount_minor, a.currency)} · {a.capacity} vagas
        {a.waitlist_enabled ? ' · com lista de espera' : ''}
      </p>
      {error ? (
        <Alert kind="error" traceId={error.traceId}>
          {error.message}
        </Alert>
      ) : null}
      <div className="row-actions">
        {event.status !== 'DRAFT' ? (
          <Link to={`/organizador/atividades/${a.activity_id}/participantes`}>Participantes</Link>
        ) : null}
        {open && event.status !== 'CANCELLED' && !editing ? (
          <Button type="button" variant="secondary" onClick={() => setEditing(true)}>
            Editar atividade
          </Button>
        ) : null}
        {canEnd ? (
          <Button
            type="button"
            loading={busy}
            loadingText="Encerrando…"
            onClick={() =>
              void run(async () => onChange(await eventsApi.endActivity(a.activity_id)))
            }
          >
            Encerrar atividade
          </Button>
        ) : null}
        {draft && !confirmRemove ? (
          <Button type="button" variant="secondary" onClick={() => setConfirmRemove(true)}>
            Remover atividade
          </Button>
        ) : null}
        {draft && confirmRemove ? (
          <>
            <Button
              type="button"
              loading={busy}
              loadingText="Removendo…"
              onClick={() =>
                void run(async () => {
                  await eventsApi.deleteActivity(a.activity_id);
                  onRemoved();
                })
              }
            >
              Confirmar remoção
            </Button>
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              onClick={() => setConfirmRemove(false)}
            >
              Voltar
            </Button>
          </>
        ) : null}
      </div>
      {editing ? (
        <ActivityFormFields
          initial={a}
          priceLocked={!draft}
          submitLabel="Salvar atividade"
          loadingText="Salvando…"
          onCancel={() => setEditing(false)}
          onSubmit={async (values) => {
            // Sem `capacity`: é imutável e o serviço recusa o campo na edição.
            const { capacity: _capacity, ...patch } = toActivityInput(values);
            void _capacity;
            onChange(await eventsApi.updateActivity(a.activity_id, patch));
            setEditing(false);
          }}
        />
      ) : null}
    </li>
  );
}
