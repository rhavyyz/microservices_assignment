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
const LIST = 'GET /user/api/v1/admin/users';
const DECIDE = (id: string) => `PUT /user/api/v1/admin/users/${id}/organizer`;
const ADMIN = ['ADMIN'];

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const user = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  name: `Pessoa ${n}`,
  email: `pessoa${n}@example.com`,
  roles: ['PARTICIPANT'],
  status: 'ACTIVE',
  organizerRequest: 'NONE',
  organizerRequestUpdatedAt: null,
  createdAt: '2026-11-03T23:25:45.175467Z',
  ...over,
});
const page = (items: unknown[], p = 0, pages = 1) => ({
  items,
  page: p,
  size: 20,
  totalElements: items.length,
  totalPages: pages,
});

async function openAdmin(
  list: (u: URL) => Response,
  extra: Record<string, (r: { url: URL; init: RequestInit }) => Response> = {},
  roles: string[] = ADMIN,
) {
  const f = fakeFetch({
    [LOGIN]: () => jsonResponse(200, loginBody(roles)),
    [ME]: () => jsonResponse(200, profile({ roles })),
    [LIST]: ({ url }) => list(url),
    ...extra,
  });
  const ctx = renderApp(f, '/entrar');
  await fillLogin(ctx.user);
  await ctx.user.click(await screen.findByRole('link', { name: 'Administração' }));
  await screen.findByRole('heading', { name: 'Administração de usuários' });
  return { f, ...ctx };
}

const listCalls = (f: ReturnType<typeof fakeFetch>) =>
  f.mock.calls.filter((c) => new URL(String(c[0])).pathname === '/user/api/v1/admin/users');

describe('Administração de usuários', () => {
  it('lista todos com Bearer, sem filtro, e mostra a situação do pedido de organizador', async () => {
    const { f } = await openAdmin(() =>
      jsonResponse(
        200,
        page([
          user(1, {
            organizerRequest: 'PENDING',
            organizerRequestUpdatedAt: '2026-11-04T10:00:00Z',
          }),
          user(2),
          user(3, { roles: ['PARTICIPANT', 'ORGANIZER'], organizerRequest: 'APPROVED' }),
        ]),
      ),
    );
    const table = await screen.findByRole('table');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(within(rows[0]!).getByText('Aguardando aprovação')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Sem pedido')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Aprovado')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Participante, Organizador')).toBeInTheDocument();

    const call = listCalls(f)[0]!;
    expect(headersOf(call).Authorization).toBe('Bearer tok.en.value');
    const url = new URL(String(call[0]));
    expect(url.searchParams.get('organizerRequest')).toBeNull();
    expect(url.searchParams.get('q')).toBeNull();
  });

  it('filtra por "Aguardando aprovação" e busca por nome ou e-mail', async () => {
    const { f, user: u } = await openAdmin(() => jsonResponse(200, page([user(1)])));
    await screen.findByRole('table');
    await u.click(screen.getByRole('button', { name: 'Aguardando aprovação' }));
    await u.type(screen.getByLabelText('Buscar por nome ou e-mail'), 'maria');
    await u.click(screen.getByRole('button', { name: 'Buscar' }));
    await screen.findByRole('table');

    const last = new URL(String(listCalls(f).at(-1)![0]));
    expect(last.searchParams.get('organizerRequest')).toBe('PENDING');
    expect(last.searchParams.get('q')).toBe('maria');
    expect(screen.getByRole('button', { name: 'Aguardando aprovação' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('aprova: envia approved=true, atualiza a linha e lembra de entrar de novo', async () => {
    const { f, user: u } = await openAdmin(
      () => jsonResponse(200, page([user(1, { organizerRequest: 'PENDING' })])),
      {
        [DECIDE(id(1))]: () =>
          jsonResponse(
            200,
            user(1, { roles: ['PARTICIPANT', 'ORGANIZER'], organizerRequest: 'APPROVED' }),
          ),
      },
    );
    await u.click(await screen.findByRole('button', { name: 'Aprovar Pessoa 1 como organizador' }));

    expect(await screen.findByText(/agora é organizador/)).toBeInTheDocument();
    expect(screen.getByText(/sair e entrar de novo/)).toBeInTheDocument();
    const row = screen.getAllByRole('row')[1]!;
    expect(within(row).getByText('Aprovado')).toBeInTheDocument();
    expect(
      within(row).getByRole('button', { name: 'Retirar o papel de organizador de Pessoa 1' }),
    ).toBeInTheDocument();
    const call = f.mock.calls.find((c) => String(c[1]?.method) === 'PUT')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ approved: true });
    expect(headersOf(call).Authorization).toBe('Bearer tok.en.value');
  });

  it('nega o pedido pendente: envia approved=false', async () => {
    const { f, user: u } = await openAdmin(
      () => jsonResponse(200, page([user(1, { organizerRequest: 'PENDING' })])),
      { [DECIDE(id(1))]: () => jsonResponse(200, user(1, { organizerRequest: 'DENIED' })) },
    );
    await u.click(await screen.findByRole('button', { name: 'Negar o pedido de Pessoa 1' }));
    expect(await screen.findByText('Negado')).toBeInTheDocument();
    const call = f.mock.calls.find((c) => String(c[1]?.method) === 'PUT')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ approved: false });
  });

  it('retirar o papel pede confirmação e só então chama a API', async () => {
    const { f, user: u } = await openAdmin(
      () =>
        jsonResponse(
          200,
          page([user(1, { roles: ['PARTICIPANT', 'ORGANIZER'], organizerRequest: 'APPROVED' })]),
        ),
      { [DECIDE(id(1))]: () => jsonResponse(200, user(1, { organizerRequest: 'DENIED' })) },
    );
    await u.click(
      await screen.findByRole('button', { name: 'Retirar o papel de organizador de Pessoa 1' }),
    );
    expect(f.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false);

    await u.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(
      screen.getByRole('button', { name: 'Retirar o papel de organizador de Pessoa 1' }),
    ).toBeInTheDocument();
    expect(f.mock.calls.some((c) => c[1]?.method === 'PUT')).toBe(false);

    await u.click(
      screen.getByRole('button', { name: 'Retirar o papel de organizador de Pessoa 1' }),
    );
    await u.click(
      screen.getByRole('button', { name: 'Confirmar a retirada do papel de Pessoa 1' }),
    );
    expect(await screen.findByText('Negado')).toBeInTheDocument();
    expect(f.mock.calls.filter((c) => c[1]?.method === 'PUT')).toHaveLength(1);
  });

  it('"Negar" só existe para pedido pendente; quem nunca pediu ou já foi negado só pode ser aprovado', async () => {
    await openAdmin(() =>
      jsonResponse(
        200,
        page([
          user(1, { organizerRequest: 'PENDING' }),
          user(2),
          user(3, { organizerRequest: 'DENIED' }),
        ]),
      ),
    );
    await screen.findByRole('table');
    expect(screen.getByRole('button', { name: 'Negar o pedido de Pessoa 1' })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Negar o pedido de Pessoa 2' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Negar o pedido de Pessoa 3' }),
    ).not.toBeInTheDocument();
    for (const n of [1, 2, 3]) {
      expect(
        screen.getByRole('button', { name: `Aprovar Pessoa ${n} como organizador` }),
      ).toBeInTheDocument();
    }
  });

  it('administradores não têm ações e o próprio usuário é identificado', async () => {
    await openAdmin(() =>
      jsonResponse(200, page([user(1, { roles: ['ADMIN'], name: 'Maria Silva' }), user(2)])),
    );
    // o id do usuário logado é USER_ID; o outro admin aqui é só outro ADMIN
    const rows = (await screen.findAllByRole('row')).slice(1);
    expect(within(rows[0]!).queryByRole('button')).not.toBeInTheDocument();
    expect(within(rows[0]!).getByText('Administrador')).toBeInTheDocument();
    expect(within(rows[1]!).getByRole('button', { name: /Aprovar Pessoa 2/ })).toBeInTheDocument();
  });

  it('erro da decisão (409 de administrador) aparece sem esconder a lista', async () => {
    const { user: u } = await openAdmin(() => jsonResponse(200, page([user(1)])), {
      [DECIDE(id(1))]: () =>
        problem(
          409,
          'ADMIN_TARGET_NOT_ALLOWED',
          'Não é possível alterar o papel de um administrador.',
        ),
    });
    await u.click(await screen.findByRole('button', { name: /Aprovar Pessoa 1/ }));
    expect(
      await screen.findByText('Não é possível alterar o papel de um administrador.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('table')).toBeInTheDocument();
  });

  it('mostra erro com "Tentar novamente" e lista vazia com aviso', async () => {
    let calls = 0;
    const { user: u } = await openAdmin(() => {
      calls += 1;
      return calls === 1
        ? problem(500, 'INTERNAL_ERROR', 'Erro interno.')
        : jsonResponse(200, page([]));
    });
    await u.click(await screen.findByRole('button', { name: 'Tentar novamente' }));
    expect(
      await screen.findByText('Nenhum usuário encontrado para este filtro.'),
    ).toBeInTheDocument();
  });

  it('pagina enviando page/size', async () => {
    const { f, user: u } = await openAdmin(() => jsonResponse(200, page([user(1)], 0, 3)));
    await screen.findByRole('table');
    await u.click(screen.getByRole('button', { name: 'Próxima' }));
    await screen.findByRole('table');
    const url = new URL(String(listCalls(f).at(-1)![0]));
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('size')).toBe('20');
  });

  it('quem não é administrador não vê o menu nem entra na rota (acesso negado) e nada é chamado', async () => {
    const f = fakeFetch({
      [LOGIN]: () => jsonResponse(200, loginBody(['PARTICIPANT', 'ORGANIZER'])),
      [ME]: () => jsonResponse(200, profile()),
    });
    const ctx = renderApp(f, { pathname: '/entrar', state: { from: '/admin/usuarios' } });
    await fillLogin(ctx.user);
    expect(await screen.findByText(/acesso negado/i)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Administração' })).not.toBeInTheDocument();
    expect(listCalls(f)).toHaveLength(0);
  });
});
