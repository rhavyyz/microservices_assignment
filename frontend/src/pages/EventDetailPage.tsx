import { useEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { describeError, isAbortError, toApiError, type ErrorDescription } from '../api/errors';
import type { Activity, EventDetail } from '../api/eventsSchemas';
import { ACTIVE_STATUSES, type Availability, type Registration } from '../api/subscriptionSchemas';
import { useAuth } from '../auth/AuthContext';
import { formatPeriod, formatPrice, hasEnded, isUuid } from '../components/format';
import { STATUS_HINTS, STATUS_LABELS } from '../components/registration';
import { Alert, Button, LoadingState } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { useServices } from '../services/ServicesContext';
import { NotFoundPage } from './NotFoundPage';

type Load =
  | { key: string; kind: 'done'; event: EventDetail }
  | { key: string; kind: 'error'; error: ErrorDescription; notFound: boolean };

interface AvailabilityState {
  key: string;
  byActivity: Record<string, Availability>;
}

interface MyRegistrations {
  userId: string;
  byActivity: Record<string, Registration>;
  failed: boolean;
}

/** Só exibe banner vindo de URL https (a imagem é de terceiros: sem referrer e sem rastreio de origem). */
function safeBannerUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

export function EventDetailPage() {
  const { eventId = '' } = useParams();
  return isUuid(eventId) ? <EventDetailView eventId={eventId} /> : <NotFoundPage />;
}

function EventDetailView({ eventId }: { eventId: string }) {
  const { eventsApi, subscriptionApi } = useServices();
  const { session } = useAuth();
  const userId = session?.user.id ?? null;
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load | null>(null);
  const [mine, setMine] = useState<MyRegistrations | null>(null);
  const [availability, setAvailability] = useState<AvailabilityState | null>(null);
  const key = `${eventId}|${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    eventsApi
      .getEvent(eventId, controller.signal)
      .then((event) => setLoad({ key, kind: 'done', event }))
      .catch((e: unknown) => {
        if (isAbortError(e)) return;
        setLoad({
          key,
          kind: 'error',
          error: describeError(e),
          notFound: toApiError(e).status === 404,
        });
      });
    return () => controller.abort();
  }, [eventsApi, eventId, key]);

  // Inscrições vivas do usuário, para marcar as atividades em que ele já está inscrito.
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    subscriptionApi
      .listMine({ limit: 100 }, controller.signal)
      .then((list) => {
        const byActivity: Record<string, Registration> = {};
        for (const r of list) if (ACTIVE_STATUSES.includes(r.status)) byActivity[r.activity_id] = r;
        setMine({ userId, byActivity, failed: false });
      })
      .catch((e: unknown) => {
        if (!isAbortError(e)) setMine({ userId, byActivity: {}, failed: true });
      });
    return () => controller.abort();
  }, [subscriptionApi, userId]);

  const current = load?.key === key ? load : null;
  const event = current?.kind === 'done' ? current.event : null;

  // Vagas livres vêm de Inscrições (Eventos só informa a capacidade) e exigem login. Falhas são toleradas: sem o
  // número, a tela mostra só a capacidade e deixa o servidor decidir no momento da inscrição.
  const openIds =
    event?.activities.filter((a) => a.registration_open).map((a) => a.activity_id) ?? [];
  const availKey = userId ? `${key}|${userId}|${openIds.join(',')}` : null;
  useEffect(() => {
    if (!availKey || openIds.length === 0) return;
    const controller = new AbortController();
    Promise.allSettled(
      openIds.map((id) => subscriptionApi.getAvailability(id, controller.signal)),
    ).then((results) => {
      if (controller.signal.aborted) return;
      const byActivity: Record<string, Availability> = {};
      results.forEach((r, i) => {
        if (r.status === 'fulfilled') byActivity[openIds[i]!] = r.value;
      });
      setAvailability({ key: availKey, byActivity });
    });
    return () => controller.abort();
    // openIds é derivado de availKey; incluí-lo aqui só reexecutaria o efeito sem necessidade.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscriptionApi, availKey]);
  const knownAvailability =
    availability && availability.key === availKey ? availability.byActivity : {};
  usePageTitle(event?.title ?? 'Evento');
  const myRegs = mine && mine.userId === userId ? mine : null;

  function onRegistered(reg: Registration) {
    if (!userId) return;
    setMine((m) => ({
      userId,
      byActivity: { ...(m && m.userId === userId ? m.byActivity : {}), [reg.activity_id]: reg },
      failed: false,
    }));
  }

  if (!current) return <LoadingState label="Carregando evento…" />;
  if (current.kind === 'error') {
    if (current.notFound) return <NotFoundPage />;
    return (
      <section className="card">
        <Alert kind="error" traceId={current.error.traceId}>
          {current.error.message}
        </Alert>
        <Button type="button" variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
          Tentar novamente
        </Button>
      </section>
    );
  }

  const banner = safeBannerUrl(current.event.banner_url);
  const eventEnded = hasEnded(current.event.ends_at);
  return (
    <article className="event">
      <p>
        <Link to="/eventos">← Voltar aos eventos</Link>
      </p>
      {banner ? (
        <img className="banner" src={banner} alt="" referrerPolicy="no-referrer" loading="lazy" />
      ) : null}
      <h1>{current.event.title}</h1>
      {current.event.organization ? <p className="muted">{current.event.organization}</p> : null}
      <p>{formatPeriod(current.event.starts_at, current.event.ends_at)}</p>
      {current.event.location ? <p className="muted">{current.event.location}</p> : null}
      {current.event.description ? (
        <p className="description">{current.event.description}</p>
      ) : null}

      {current.event.status === 'CANCELLED' ? (
        <Alert kind="error">Este evento foi cancelado.</Alert>
      ) : eventEnded ? (
        <Alert kind="info">Este evento já terminou. Não é possível se inscrever.</Alert>
      ) : null}
      {userId && myRegs?.failed ? (
        <Alert kind="info">
          Não foi possível carregar as suas inscrições agora; elas podem não aparecer abaixo.
        </Alert>
      ) : null}

      <h2>Atividades</h2>
      {current.event.activities.length === 0 ? (
        <Alert kind="info">Este evento ainda não tem atividades.</Alert>
      ) : (
        <ul className="activities">
          {current.event.activities.map((a) => (
            <ActivityCard
              key={a.activity_id}
              activity={a}
              registration={myRegs?.byActivity[a.activity_id]}
              availability={knownAvailability[a.activity_id]}
              authenticated={userId !== null}
              onRegistered={onRegistered}
            />
          ))}
        </ul>
      )}
    </article>
  );
}

function ActivityCard({
  activity,
  registration,
  availability,
  authenticated,
  onRegistered,
}: {
  activity: Activity;
  registration: Registration | undefined;
  /** Vagas informadas por Inscrições; ausente para visitantes ou se a consulta falhou. */
  availability: Availability | undefined;
  authenticated: boolean;
  onRegistered: (r: Registration) => void;
}) {
  const { subscriptionApi } = useServices();
  const location = useLocation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDescription | null>(null);
  // Lotação descoberta só ao tentar (ex.: as vagas acabaram depois de a página carregar).
  const [foundFull, setFoundFull] = useState(false);

  const full = foundFull || (availability !== undefined && availability.available <= 0);

  async function register(joinWaitlist: boolean) {
    setBusy(true);
    setError(null);
    try {
      onRegistered(await subscriptionApi.createRegistration(activity.activity_id, joinWaitlist));
    } catch (e) {
      if (toApiError(e).code === 'ACTIVITY_FULL') setFoundFull(true);
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  let action;
  if (registration) {
    action = (
      <div className="registration-note">
        <p>
          <strong>Sua inscrição:</strong> {STATUS_LABELS[registration.status]}
        </p>
        {STATUS_HINTS[registration.status] ? (
          <p className="muted">{STATUS_HINTS[registration.status]}</p>
        ) : null}
        <p>
          <Link to="/inscricoes">Ver minhas inscrições</Link>
        </p>
      </div>
    );
  } else if (!activity.registration_open) {
    action = <p className="muted">{closedReason(activity)}</p>;
  } else if (!authenticated) {
    action = (
      <p>
        <Link to="/entrar" state={{ from: location.pathname }}>
          Entre para se inscrever
        </Link>
      </p>
    );
  } else if (full && !activity.waitlist_enabled) {
    action = <p className="muted">Esgotado.</p>;
  } else if (full) {
    action = (
      <Button
        type="button"
        variant="secondary"
        loading={busy}
        loadingText="Enviando…"
        onClick={() => void register(true)}
      >
        Entrar na lista de espera
      </Button>
    );
  } else {
    action = (
      <Button
        type="button"
        loading={busy}
        loadingText="Inscrevendo…"
        onClick={() => void register(false)}
      >
        Inscrever-se
      </Button>
    );
  }

  return (
    <li className="activity">
      <h3>{activity.title}</h3>
      {activity.speaker ? <p className="muted">Com {activity.speaker}</p> : null}
      <p>{formatPeriod(activity.starts_at, activity.ends_at)}</p>
      {activity.location ? <p className="muted">{activity.location}</p> : null}
      {activity.description ? <p>{activity.description}</p> : null}
      <p>
        {formatPrice(activity.amount_minor, activity.currency)} ·{' '}
        {seatsText(activity, availability, full)}
      </p>
      {error ? (
        <Alert kind="error" traceId={error.traceId}>
          {error.message}
        </Alert>
      ) : null}
      {action}
    </li>
  );
}

function closedReason(activity: Activity): string {
  if (activity.lifecycle === 'CANCELLED') return 'Atividade cancelada.';
  if (activity.lifecycle === 'ENDED') return 'Atividade encerrada.';
  return 'Inscrições encerradas.';
}

/** Com vagas conhecidas: "12 de 30 vagas"; sem elas (visitante ou falha), só a capacidade total. */
function seatsText(
  activity: Activity,
  availability: Availability | undefined,
  full: boolean,
): string {
  if (full) return `sem vagas${activity.waitlist_enabled ? ' (lista de espera disponível)' : ''}`;
  if (availability) return `${availability.available} de ${availability.capacity} vagas`;
  return `${activity.capacity} vagas no total`;
}
