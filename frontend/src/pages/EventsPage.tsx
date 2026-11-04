import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router';
import { z } from 'zod';
import { describeError, isAbortError, type ErrorDescription } from '../api/errors';
import type { EventPage } from '../api/eventsSchemas';
import { formatPeriod } from '../components/format';
import { Alert, Button, LoadingState, TextField } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { useServices } from '../services/ServicesContext';

const PAGE_SIZE = 12;

const filterSchema = z
  .object({
    q: z.string().trim().max(200, 'A busca deve ter no máximo 200 caracteres.'),
    from: z.string(),
    to: z.string(),
  })
  .refine((d) => d.from === '' || d.to === '' || d.from <= d.to, {
    path: ['to'],
    message: 'A data final deve ser igual ou posterior à inicial.',
  });
type FilterForm = z.infer<typeof filterSchema>;

/** Data local (YYYY-MM-DD) -> instante ISO do início/fim desse dia, no fuso do navegador. */
function dayBoundary(date: string, end: boolean): string | undefined {
  if (!date) return undefined;
  const d = new Date(`${date}T${end ? '23:59:59.999' : '00:00:00.000'}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

type Result =
  | { key: string; kind: 'done'; page: EventPage }
  | { key: string; kind: 'error'; error: ErrorDescription };

/** Catálogo público de eventos. Busca e página ficam na URL (link compartilhável; voltar/avançar funcionam). */
export function EventsPage() {
  usePageTitle('Eventos');
  const { eventsApi } = useServices();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const key = `${q}|${from}|${to}|${page}|${attempt}`;

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FilterForm>({ resolver: zodResolver(filterSchema), values: { q, from, to } });

  useEffect(() => {
    const controller = new AbortController();
    eventsApi
      .listEvents(
        {
          q: q || undefined,
          from: dayBoundary(from, false),
          to: dayBoundary(to, true),
          limit: PAGE_SIZE,
          offset: (page - 1) * PAGE_SIZE,
        },
        controller.signal,
      )
      .then((p) => setResult({ key, kind: 'done', page: p }))
      .catch((e: unknown) => {
        if (!isAbortError(e)) setResult({ key, kind: 'error', error: describeError(e) });
      });
    return () => controller.abort();
  }, [eventsApi, q, from, to, page, key]);

  const loading = result?.key !== key;

  const onSubmit = handleSubmit((v) => {
    const next = new URLSearchParams();
    if (v.q) next.set('q', v.q);
    if (v.from) next.set('from', v.from);
    if (v.to) next.set('to', v.to);
    setParams(next);
  });

  function goTo(p: number) {
    const next = new URLSearchParams(params);
    if (p <= 1) next.delete('page');
    else next.set('page', String(p));
    setParams(next);
  }

  const done = result?.kind === 'done' && result.key === key ? result.page : null;
  const totalPages = done ? Math.max(1, Math.ceil(done.total / PAGE_SIZE)) : 1;

  return (
    <section>
      <h1>Eventos</h1>
      <form
        onSubmit={onSubmit}
        noValidate
        className="search-form"
        role="search"
        aria-label="Buscar eventos"
      >
        <TextField
          label="Buscar"
          placeholder="Título, local ou organização"
          error={errors.q?.message}
          {...register('q')}
        />
        <TextField
          label="A partir de"
          type="date"
          error={errors.from?.message}
          {...register('from')}
        />
        <TextField label="Até" type="date" error={errors.to?.message} {...register('to')} />
        <Button type="submit" loading={loading} loadingText="Buscando…">
          Buscar
        </Button>
      </form>

      <div aria-live="polite">
        {loading ? <LoadingState label="Carregando eventos…" /> : null}
        {result?.kind === 'error' && result.key === key ? (
          <>
            <Alert kind="error" traceId={result.error.traceId}>
              {result.error.message}
            </Alert>
            <Button type="button" variant="secondary" onClick={() => setAttempt((a) => a + 1)}>
              Tentar novamente
            </Button>
          </>
        ) : null}
        {done && done.items.length === 0 ? (
          <Alert kind="info">Nenhum evento encontrado.</Alert>
        ) : null}
        {done && done.items.length > 0 ? (
          <>
            <p>
              {done.total} {done.total === 1 ? 'evento encontrado' : 'eventos encontrados'}
            </p>
            <ul className="cards">
              {done.items.map((e) => (
                <li key={e.event_id} className="event-card">
                  <h2>
                    <Link to={`/eventos/${e.event_id}`}>{e.title}</Link>
                  </h2>
                  {e.organization ? <p className="muted">{e.organization}</p> : null}
                  <p>{formatPeriod(e.starts_at, e.ends_at)}</p>
                  {e.location ? <p className="muted">{e.location}</p> : null}
                </li>
              ))}
            </ul>
            <nav className="pager" aria-label="Paginação">
              <Button
                type="button"
                variant="secondary"
                disabled={page <= 1}
                onClick={() => goTo(page - 1)}
              >
                Anterior
              </Button>
              <span>
                Página {page} de {totalPages}
              </span>
              <Button
                type="button"
                variant="secondary"
                disabled={page >= totalPages}
                onClick={() => goTo(page + 1)}
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
