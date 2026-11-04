import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { Certificate } from '../api/certificatesApi';
import { describeError, isAbortError, type ErrorDescription } from '../api/errors';
import { saveBlob } from '../components/download';
import { formatDateTime } from '../components/format';
import { Alert, Button, LoadingState } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { useServices } from '../services/ServicesContext';

const PAGE_SIZE = 50;

type Result =
  | { key: string; kind: 'done'; items: Certificate[]; titles: Record<string, string> }
  | { key: string; kind: 'error'; error: ErrorDescription };

/** Meus certificados: emitidos pelo serviço depois que o evento termina e a presença chega a 75%. */
export function CertificatesPage() {
  usePageTitle('Meus certificados');
  const { certificatesApi, eventsApi } = useServices();
  const [page, setPage] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const key = `${page}|${attempt}`;

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    (async () => {
      const items = await certificatesApi.listMine(
        { limit: PAGE_SIZE, offset: page * PAGE_SIZE },
        signal,
      );
      // O nome do evento vem de Eventos (leitura pública). Se falhar, o certificado aparece sem o nome.
      const ids = [...new Set(items.flatMap((c) => (c.event_id ? [c.event_id] : [])))];
      const settled = await Promise.allSettled(ids.map((id) => eventsApi.getEvent(id, signal)));
      const titles: Record<string, string> = {};
      settled.forEach((s, i) => {
        if (s.status === 'fulfilled') titles[ids[i]!] = s.value.title;
      });
      setResult({ key, kind: 'done', items, titles });
    })().catch((e: unknown) => {
      if (!isAbortError(e)) setResult({ key, kind: 'error', error: describeError(e) });
    });
    return () => controller.abort();
  }, [certificatesApi, eventsApi, page, key]);

  const current = result?.key === key ? result : null;
  return (
    <section>
      <h1>Meus certificados</h1>
      <div aria-live="polite">
        {!current ? <LoadingState label="Carregando certificados…" /> : null}
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
            {page === 0 ? (
              <>
                Você ainda não tem certificados. Eles são emitidos automaticamente depois que o
                evento termina, para quem tem presença em pelo menos 75% das atividades. Veja suas{' '}
                <Link to="/inscricoes">inscrições</Link>.
              </>
            ) : (
              'Não há mais certificados.'
            )}
          </Alert>
        ) : null}
        {current?.kind === 'done' && current.items.length > 0 ? (
          <>
            <ul className="cards">
              {current.items.map((c) => (
                <CertificateCard
                  key={c.id}
                  certificate={c}
                  title={c.event_id ? current.titles[c.event_id] : undefined}
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

function CertificateCard({
  certificate: c,
  title,
}: {
  certificate: Certificate;
  title: string | undefined;
}) {
  const { certificatesApi } = useServices();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorDescription | null>(null);

  async function download() {
    setBusy(true);
    setError(null);
    try {
      saveBlob(await certificatesApi.downloadPdf(c.id), `certificado-${c.id}.pdf`);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="event-card">
      <h2>{title ?? 'Certificado de participação'}</h2>
      <p className="muted">Emitido em {formatDateTime(c.issued_at)}</p>
      {c.event_id ? (
        <p>
          <Link to={`/eventos/${c.event_id}`}>Ver evento</Link>
        </p>
      ) : null}
      {error ? (
        <Alert kind="error" traceId={error.traceId}>
          {error.message}
        </Alert>
      ) : null}
      <Button type="button" loading={busy} loadingText="Baixando…" onClick={() => void download()}>
        Baixar PDF
      </Button>
    </li>
  );
}
