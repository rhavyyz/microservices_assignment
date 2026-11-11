import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { describeError, isAbortError, toApiError, type ErrorDescription } from '../api/errors';
import { FINAL_PAYMENT_STATUSES, type Payment, type SimulateAction } from '../api/paymentsSchemas';
import { formatDateTime, formatPrice, hasEnded, isUuid } from '../components/format';
import { PAYMENT_HINTS, PAYMENT_LABELS, paymentPolling, paymentTone } from '../components/payment';
import { Alert, Button, LoadingState } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { useServices } from '../services/ServicesContext';
import { NotFoundPage } from './NotFoundPage';

type Load =
  | { key: string; kind: 'done'; payment: Payment }
  | { key: string; kind: 'error'; error: ErrorDescription; notFound: boolean };

export function PaymentPage() {
  const { paymentId = '' } = useParams();
  return isUuid(paymentId) ? <PaymentView paymentId={paymentId} /> : <NotFoundPage />;
}

function PaymentView({ paymentId }: { paymentId: string }) {
  usePageTitle('Pagamento');
  const { paymentsApi } = useServices();
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load | null>(null);
  const [tick, setTick] = useState(0);
  const key = `${paymentId}|${attempt}`;
  const status = load?.key === key && load.kind === 'done' ? load.payment.status : null;

  useEffect(() => {
    const controller = new AbortController();
    paymentsApi
      .getPayment(paymentId, controller.signal)
      .then((payment) => setLoad({ key, kind: 'done', payment }))
      .catch((e: unknown) => {
        if (isAbortError(e)) return;
        setLoad((prev) => {
          // Falha numa atualização periódica não apaga o que já está na tela.
          if (prev?.key === key && prev.kind === 'done') return prev;
          const err = toApiError(e);
          return { key, kind: 'error', error: describeError(err), notFound: err.status === 404 };
        });
      });
    return () => controller.abort();
  }, [paymentsApi, paymentId, key, tick]);

  // Enquanto pendente, consulta de novo; para ao chegar a um estado final.
  useEffect(() => {
    if (status !== 'PENDING') return;
    const t = setTimeout(() => setTick((n) => n + 1), paymentPolling.intervalMs);
    return () => clearTimeout(t);
  }, [status, tick]);

  const current = load?.key === key ? load : null;
  if (!current) return <LoadingState label="Carregando pagamento…" />;
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
    <PaymentDetails
      payment={current.payment}
      onChange={(payment) => setLoad({ key, kind: 'done', payment })}
    />
  );
}

const ACTIONS: { action: SimulateAction; label: string; busy: string }[] = [
  { action: 'approve', label: 'Aprovar pagamento', busy: 'Aprovando…' },
  { action: 'decline', label: 'Recusar pagamento', busy: 'Recusando…' },
  { action: 'expire', label: 'Deixar o prazo expirar', busy: 'Expirando…' },
];

function PaymentDetails({
  payment: p,
  onChange,
}: {
  payment: Payment;
  onChange: (p: Payment) => void;
}) {
  const { paymentsApi } = useServices();
  const [busy, setBusy] = useState<SimulateAction | null>(null);
  const [error, setError] = useState<ErrorDescription | null>(null);
  const pending = p.status === 'PENDING';
  const final = FINAL_PAYMENT_STATUSES.includes(p.status);

  async function simulate(action: SimulateAction) {
    setBusy(action);
    setError(null);
    try {
      onChange(await paymentsApi.simulate(p.payment_id, action));
    } catch (e) {
      setError(describeError(e));
      if (toApiError(e).status === 409) {
        // Não foi aplicado (já final ou prazo vencido): mostra o estado real.
        try {
          onChange(await paymentsApi.getPayment(p.payment_id));
        } catch {
          /* a mensagem de erro acima já explica; o estado será atualizado na próxima consulta */
        }
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card">
      <h1>Pagamento</h1>
      <p>
        <span className={`badge badge-${paymentTone(p.status)}`}>{PAYMENT_LABELS[p.status]}</span>
      </p>
      <p className="lead">{formatPrice(p.amount_minor, p.currency)}</p>
      <p aria-live="polite">{PAYMENT_HINTS[p.status]}</p>
      {pending ? (
        <p>
          Prazo: {formatDateTime(p.expires_at)}
          {hasEnded(p.expires_at) ? ' (já passou; o status será atualizado em instantes)' : ''}
        </p>
      ) : null}
      <p className="muted">Pagamento criado em {formatDateTime(p.created_at)}</p>

      {error ? (
        <Alert kind="error" traceId={error.traceId}>
          {error.message}
        </Alert>
      ) : null}

      {pending ? (
        <div className="card" aria-label="Provedor de pagamento simulado">
          <h2>Provedor simulado</h2>
          <p className="muted">
            Ambiente de demonstração: nenhuma cobrança real é feita. Escolha o resultado do
            pagamento.
          </p>
          <div className="row-actions">
            {ACTIONS.map((a) => (
              <Button
                key={a.action}
                type="button"
                variant={a.action === 'approve' ? 'primary' : 'secondary'}
                loading={busy === a.action}
                loadingText={a.busy}
                disabled={busy !== null && busy !== a.action}
                onClick={() => void simulate(a.action)}
              >
                {a.label}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <p className="row-actions">
        <Link to="/inscricoes">Minhas inscrições</Link>
        {final && p.status !== 'APPROVED' && p.event_id ? (
          <Link to={`/eventos/${p.event_id}`}>Ver evento</Link>
        ) : null}
      </p>
    </section>
  );
}
