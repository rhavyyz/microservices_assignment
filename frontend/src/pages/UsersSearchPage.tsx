import { zodResolver } from '@hookform/resolvers/zod';
import { useEffect, useState } from 'react';
import { useForm } from 'react-hook-form';
import { describeError, isAbortError, toApiError, type ErrorDescription } from '../api/errors';
import type { UserPage } from '../api/schemas';
import { roleLabels } from '../components/roles';
import { Alert, Button, LoadingState, TextField } from '../components/ui';
import { usePageTitle } from '../components/usePageTitle';
import { searchSchema, type SearchForm } from '../schemas/forms';
import { useServices } from '../services/ServicesContext';

const PAGE_SIZE = 10;

type State =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; error: ErrorDescription; forbidden: boolean }
  | { kind: 'done'; filters: SearchForm; result: UserPage };

/** Busca de usuários (organizadores). O servidor decide: um 403 é exibido como acesso recusado. */
export function UsersSearchPage() {
  usePageTitle('Usuários');
  const { usersApi } = useServices();
  const [state, setState] = useState<State>({ kind: 'idle' });
  const [query, setQuery] = useState<{ filters: SearchForm; page: number } | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SearchForm>({
    resolver: zodResolver(searchSchema),
    defaultValues: { id: '', email: '', name: '' },
  });

  // Cada busca (ou troca de página) roda num efeito com cancelamento: uma resposta antiga nunca sobrescreve a nova.
  useEffect(() => {
    if (!query) return;
    const controller = new AbortController();
    const { filters, page } = query;
    usersApi
      .searchUsers(
        { id: filters.id, email: filters.email, name: filters.name, page, size: PAGE_SIZE },
        controller.signal,
      )
      .then((result) => setState({ kind: 'done', filters, result }))
      .catch((e: unknown) => {
        if (isAbortError(e)) return;
        const error = describeError(e);
        setState({ kind: 'error', error, forbidden: toApiError(e).code === 'ACCESS_DENIED' });
      });
    return () => controller.abort();
  }, [usersApi, query]);

  function search(filters: SearchForm, page: number) {
    setState({ kind: 'loading' });
    setQuery({ filters, page });
  }

  const onSubmit = handleSubmit((filters) => search(filters, 0));
  const searching = state.kind === 'loading';

  return (
    <section className="card">
      <h1>Buscar usuários</h1>
      <p className="lead">
        Informe ao menos um filtro. Os filtros de e-mail e nome buscam por trecho.
      </p>
      <form onSubmit={onSubmit} noValidate className="search-form">
        <TextField label="ID" autoComplete="off" error={errors.id?.message} {...register('id')} />
        <TextField
          label="E-mail"
          autoComplete="off"
          error={errors.email?.message}
          {...register('email')}
        />
        <TextField
          label="Nome"
          autoComplete="off"
          error={errors.name?.message}
          {...register('name')}
        />
        <Button type="submit" loading={searching} loadingText="Buscando…">
          Buscar
        </Button>
      </form>

      <div aria-live="polite">
        {state.kind === 'loading' ? <LoadingState label="Buscando usuários…" /> : null}
        {state.kind === 'error' ? (
          <Alert kind="error" traceId={state.error.traceId}>
            {state.forbidden
              ? 'Acesso recusado: esta busca é exclusiva para organizadores.'
              : state.error.message}
          </Alert>
        ) : null}
        {state.kind === 'done' ? (
          <Results state={state} onPage={(p) => search(state.filters, p)} />
        ) : null}
      </div>
    </section>
  );
}

function Results({
  state,
  onPage,
}: {
  state: Extract<State, { kind: 'done' }>;
  onPage: (page: number) => void;
}) {
  const { result } = state;
  if (result.items.length === 0)
    return <Alert kind="info">Nenhum usuário encontrado para os filtros informados.</Alert>;
  const lastPage = Math.max(result.totalPages - 1, 0);
  return (
    <>
      <p>
        {result.totalElements}{' '}
        {result.totalElements === 1 ? 'usuário encontrado' : 'usuários encontrados'}
      </p>
      <div className="table-wrap">
        <table>
          <caption className="sr-only">Resultado da busca de usuários</caption>
          <thead>
            <tr>
              <th scope="col">Nome</th>
              <th scope="col">E-mail</th>
              <th scope="col">Papéis</th>
              <th scope="col">Situação</th>
            </tr>
          </thead>
          <tbody>
            {result.items.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td>{u.email}</td>
                <td>{roleLabels(u.roles)}</td>
                <td>{u.status === 'ACTIVE' ? 'Ativo' : 'Inativo'}</td>
              </tr>
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
