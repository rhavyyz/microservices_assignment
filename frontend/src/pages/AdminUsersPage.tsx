import { useEffect, useState } from 'react';
import { describeError, isAbortError, type ErrorDescription } from '../api/errors';
import type { AdminUserItem, AdminUserPage, OrganizerRequest } from '../api/schemas';
import { useAuth } from '../auth/AuthContext';
import { formatDateTime } from '../components/format';
import { ORGANIZER_REQUEST_LABELS, ORGANIZER_REQUEST_TONE, roleLabels } from '../components/roles';
import { Alert, Button, LoadingState, TextField } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { useServices } from '../services/ServicesContext';

const PAGE_SIZE = 20;

type Filter = OrganizerRequest | 'ALL';
const FILTERS: { value: Filter; label: string }[] = [
  { value: 'ALL', label: 'Todos' },
  { value: 'PENDING', label: 'Aguardando aprovação' },
  { value: 'APPROVED', label: 'Aprovados' },
  { value: 'DENIED', label: 'Negados' },
  { value: 'NONE', label: 'Sem pedido' },
];

type State =
  | { kind: 'loading' }
  | { kind: 'error'; error: ErrorDescription }
  | { kind: 'done'; result: AdminUserPage };

interface Query {
  q: string;
  filter: Filter;
  page: number;
  attempt: number;
}

/**
 * Administração: lista todos os usuários, mostra quem pediu para ser organizador e deixa o administrador
 * conceder ou negar o papel. É só a interface: o servidor exige o papel ADMIN em cada chamada.
 */
export function AdminUsersPage() {
  usePageTitle('Administração');
  const { usersApi } = useServices();
  const { session } = useAuth();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [query, setQuery] = useState<Query>({ q: '', filter: 'ALL', page: 0, attempt: 0 });
  const [draft, setDraft] = useState('');
  const [rowError, setRowError] = useState<ErrorDescription | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Cada consulta roda num efeito com cancelamento: uma resposta antiga nunca sobrescreve a nova.
  useEffect(() => {
    const controller = new AbortController();
    usersApi
      .adminListUsers(
        {
          q: query.q || undefined,
          organizerRequest: query.filter === 'ALL' ? undefined : query.filter,
          page: query.page,
          size: PAGE_SIZE,
        },
        controller.signal,
      )
      .then((result) => setState({ kind: 'done', result }))
      .catch((e: unknown) => {
        if (!isAbortError(e)) setState({ kind: 'error', error: describeError(e) });
      });
    return () => controller.abort();
  }, [usersApi, query]);

  function go(next: Partial<Query>) {
    setState({ kind: 'loading' });
    setRowError(null);
    setNotice(null);
    setQuery((q) => ({ ...q, ...next }));
  }

  function replaceRow(updated: AdminUserItem, approved: boolean) {
    setRowError(null);
    setNotice(
      approved
        ? `${updated.name} agora é organizador. A pessoa precisa sair e entrar de novo para usar o novo papel.`
        : `${updated.name} não é mais organizador (ou o pedido foi negado).`,
    );
    setState((s) =>
      s.kind === 'done'
        ? {
            kind: 'done',
            result: {
              ...s.result,
              items: s.result.items.map((i) => (i.id === updated.id ? updated : i)),
            },
          }
        : s,
    );
  }

  return (
    <section className="card">
      <h1>Administração de usuários</h1>
      <p className="lead">
        Veja todos os usuários e quem pediu para ser organizador. O papel de organizador só vale
        depois da sua aprovação.
      </p>

      <form
        className="search-form"
        onSubmit={(e) => {
          e.preventDefault();
          go({ q: draft.trim(), page: 0 });
        }}
      >
        <TextField
          label="Buscar por nome ou e-mail"
          autoComplete="off"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <Button type="submit">Buscar</Button>
      </form>

      <div className="filter-row" role="group" aria-label="Filtrar pelo pedido de organizador">
        {FILTERS.map((f) => (
          <Button
            key={f.value}
            type="button"
            variant={query.filter === f.value ? 'primary' : 'secondary'}
            aria-pressed={query.filter === f.value}
            onClick={() => go({ filter: f.value, page: 0 })}
          >
            {f.label}
          </Button>
        ))}
      </div>

      <div aria-live="polite">
        {notice ? <Alert kind="success">{notice}</Alert> : null}
        {rowError ? (
          <Alert kind="error" traceId={rowError.traceId}>
            {rowError.message}
          </Alert>
        ) : null}
        {state.kind === 'loading' ? <LoadingState label="Carregando usuários…" /> : null}
        {state.kind === 'error' ? (
          <>
            <Alert kind="error" traceId={state.error.traceId}>
              {state.error.message}
            </Alert>
            <Button
              type="button"
              variant="secondary"
              onClick={() => go({ attempt: query.attempt + 1 })}
            >
              Tentar novamente
            </Button>
          </>
        ) : null}
        {state.kind === 'done' ? (
          <Results
            result={state.result}
            currentUserId={session?.user.id}
            onDecided={replaceRow}
            onError={setRowError}
            onPage={(page) => go({ page })}
          />
        ) : null}
      </div>
    </section>
  );
}

function Results({
  result,
  currentUserId,
  onDecided,
  onError,
  onPage,
}: {
  result: AdminUserPage;
  currentUserId: string | undefined;
  onDecided: (updated: AdminUserItem, approved: boolean) => void;
  onError: (error: ErrorDescription | null) => void;
  onPage: (page: number) => void;
}) {
  if (result.items.length === 0)
    return <Alert kind="info">Nenhum usuário encontrado para este filtro.</Alert>;
  const lastPage = Math.max(result.totalPages - 1, 0);
  return (
    <>
      <p>
        {result.totalElements} {result.totalElements === 1 ? 'usuário' : 'usuários'}
      </p>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Usuários e pedidos de organizador</caption>
          <thead>
            <tr>
              <th scope="col">Nome</th>
              <th scope="col">E-mail</th>
              <th scope="col">Papéis</th>
              <th scope="col">Pedido de organizador</th>
              <th scope="col">Ação</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((u) => (
              <UserRow
                key={u.id}
                user={u}
                isSelf={u.id === currentUserId}
                onDecided={onDecided}
                onError={onError}
              />
            ))}
          </tbody>
        </table>
      </div>
      <nav className="pager" aria-label="Paginação">
        <Button
          type="button"
          variant="secondary"
          disabled={result.page <= 0}
          onClick={() => onPage(result.page - 1)}
        >
          Anterior
        </Button>
        <span>
          Página {result.page + 1} de {Math.max(result.totalPages, 1)}
        </span>
        <Button
          type="button"
          variant="secondary"
          disabled={result.page >= lastPage}
          onClick={() => onPage(result.page + 1)}
        >
          Próxima
        </Button>
      </nav>
    </>
  );
}

function UserRow({
  user,
  isSelf,
  onDecided,
  onError,
}: {
  user: AdminUserItem;
  isSelf: boolean;
  onDecided: (updated: AdminUserItem, approved: boolean) => void;
  onError: (error: ErrorDescription | null) => void;
}) {
  const { usersApi } = useServices();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isAdmin = user.roles.includes('ADMIN');
  const isOrganizer = user.roles.includes('ORGANIZER');

  async function decide(approved: boolean) {
    setBusy(true);
    setConfirming(false);
    onError(null);
    try {
      onDecided(await usersApi.adminDecideOrganizer(user.id, approved), approved);
    } catch (e) {
      onError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <tr>
      <td>
        {user.name}
        {isSelf ? ' (você)' : ''}
      </td>
      <td>{user.email}</td>
      <td>{roleLabels(user.roles)}</td>
      <td>
        <span className={`badge badge-${ORGANIZER_REQUEST_TONE[user.organizerRequest]}`}>
          {ORGANIZER_REQUEST_LABELS[user.organizerRequest]}
        </span>
        {user.organizerRequestUpdatedAt ? (
          <small className="muted"> em {formatDateTime(user.organizerRequestUpdatedAt)}</small>
        ) : null}
      </td>
      <td>
        {isAdmin ? (
          '—'
        ) : (
          <div className="row-actions">
            {!isOrganizer ? (
              <Button
                type="button"
                loading={busy}
                loadingText="Salvando…"
                aria-label={`Aprovar ${user.name} como organizador`}
                onClick={() => void decide(true)}
              >
                Aprovar
              </Button>
            ) : null}
            {!isOrganizer && user.organizerRequest === 'PENDING' ? (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                aria-label={`Negar o pedido de ${user.name}`}
                onClick={() => void decide(false)}
              >
                Negar
              </Button>
            ) : null}
            {isOrganizer && !confirming ? (
              <Button
                type="button"
                variant="secondary"
                disabled={busy}
                aria-label={`Retirar o papel de organizador de ${user.name}`}
                onClick={() => setConfirming(true)}
              >
                Retirar papel
              </Button>
            ) : null}
            {isOrganizer && confirming ? (
              <>
                <Button
                  type="button"
                  loading={busy}
                  loadingText="Salvando…"
                  aria-label={`Confirmar a retirada do papel de ${user.name}`}
                  onClick={() => void decide(false)}
                >
                  Confirmar retirada
                </Button>
                <Button type="button" variant="secondary" onClick={() => setConfirming(false)}>
                  Cancelar
                </Button>
              </>
            ) : null}
          </div>
        )}
      </td>
    </tr>
  );
}
