import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  fakeFetch,
  fillLogin,
  headersOf,
  jsonResponse,
  loginBody,
  problem,
  profile,
  renderApp,
} from '../test/helpers';

const LOGIN = 'POST /user/api/v1/auth/login';
const ME = 'GET /user/api/v1/users/me';
const SEARCH = 'GET /user/api/v1/users';
const ORG = ['PARTICIPANT', 'ORGANIZER'];

const item = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  name: `Pessoa ${n}`,
  email: `pessoa${n}@example.com`,
  roles: ['PARTICIPANT'],
  status: 'ACTIVE',
});
const page = (items: unknown[], p = 0, total = items.length, pages = 1) => ({
  items,
  page: p,
  size: 10,
  totalElements: total,
  totalPages: pages,
});

async function openSearch(search: (u: URL) => Response) {
  const f = fakeFetch({
    [LOGIN]: () => jsonResponse(200, loginBody(ORG)),
    [ME]: () => jsonResponse(200, profile({ roles: ORG })),
    [SEARCH]: ({ url }) => search(url),
  });
  const ctx = renderApp(f, '/entrar');
  await fillLogin(ctx.user);
  await ctx.user.click(await screen.findByRole('link', { name: 'Usuários' }));
  await screen.findByRole('heading', { name: 'Buscar usuários' });
  return { f, ...ctx };
}

const searchCalls = (f: ReturnType<typeof fakeFetch>) =>
  f.mock.calls.filter((c) => new URL(String(c[0])).pathname === '/user/api/v1/users');

describe('Busca de usuários (organizador)', () => {
  it('exige ao menos um filtro e não chama a API sem isso', async () => {
    const { f, user } = await openSearch(() => jsonResponse(200, page([])));
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(
      await screen.findByText('Informe ao menos um filtro: id, e-mail ou nome.'),
    ).toBeInTheDocument();
    expect(searchCalls(f)).toHaveLength(0);
  });

  it('envia os filtros como parâmetros, com Bearer Token, e lista os resultados', async () => {
    const { f, user } = await openSearch(() => jsonResponse(200, page([item(1), item(2)], 0, 2)));
    await user.type(screen.getByLabelText('Nome'), 'pessoa');
    await user.type(screen.getByLabelText('E-mail'), 'example');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));

    const table = await screen.findByRole('table');
    expect(within(table).getByText('Pessoa 1')).toBeInTheDocument();
    expect(within(table).getByText('pessoa2@example.com')).toBeInTheDocument();
    expect(screen.getByText('2 usuários encontrados')).toBeInTheDocument();

    const call = searchCalls(f)[0]!;
    const url = new URL(String(call[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      name: 'pessoa',
      email: 'example',
      page: '0',
      size: '10',
    });
    expect(headersOf(call)['Authorization']).toBe('Bearer tok.en.value');
  });

  it('estado vazio: mensagem clara', async () => {
    const { user } = await openSearch(() => jsonResponse(200, page([])));
    await user.type(screen.getByLabelText('Nome'), 'ninguem');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(
      await screen.findByText('Nenhum usuário encontrado para os filtros informados.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('pagina: próxima página pede page=1 e "Anterior" fica desabilitado na primeira', async () => {
    const { f, user } = await openSearch((u) =>
      u.searchParams.get('page') === '1'
        ? jsonResponse(200, page([item(11)], 1, 11, 2))
        : jsonResponse(200, page([item(1)], 0, 11, 2)),
    );
    await user.type(screen.getByLabelText('Nome'), 'pessoa');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    await screen.findByText('Pessoa 1');
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    expect(screen.getByText('Página 1 de 2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(await screen.findByText('Pessoa 11')).toBeInTheDocument();
    expect(screen.getByText('Página 2 de 2')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled();
    expect(new URL(String(searchCalls(f)[1]![0])).searchParams.get('page')).toBe('1');
  });

  it('403 do servidor é mostrado como acesso recusado (a interface não decide a autorização)', async () => {
    const { user } = await openSearch(() =>
      problem(403, 'ACCESS_DENIED', 'Você não tem permissão para esta operação.'),
    );
    await user.type(screen.getByLabelText('Nome'), 'pessoa');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Acesso recusado: esta busca é exclusiva para organizadores.',
    );
    expect(screen.getByRole('button', { name: 'Sair' })).toBeInTheDocument();
  });

  it('erro de validação do servidor (400) é exibido', async () => {
    const { user } = await openSearch(() =>
      problem(400, 'VALIDATION_ERROR', 'Verifique os parâmetros enviados.', {
        errors: [{ field: 'id', message: 'Valor inválido para o parâmetro.' }],
      }),
    );
    await user.type(screen.getByLabelText('Nome'), 'pessoa');
    await user.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Verifique os parâmetros enviados.');
  });
});
