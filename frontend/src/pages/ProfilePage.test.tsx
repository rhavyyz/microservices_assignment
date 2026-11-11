import { screen, waitFor } from '@testing-library/react';
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
  textResponse,
} from '../test/helpers';

const LOGIN = 'POST /user/api/v1/auth/login';
const ME = 'GET /user/api/v1/users/me';
const PATCH_ME = 'PATCH /user/api/v1/users/me';

const login = () => jsonResponse(200, loginBody());

describe('Página de perfil', () => {
  it('mostra o carregamento e depois os dados do usuário', async () => {
    let release: (r: Response) => void = () => undefined;
    const f = fakeFetch({
      [LOGIN]: login,
      [ME]: () => new Promise<Response>((r) => (release = r)),
    });
    const { user } = renderApp(f, '/perfil');
    await fillLogin(user);

    expect(await screen.findByText('Carregando perfil…')).toBeInTheDocument();
    release(jsonResponse(200, profile()));
    expect(await screen.findByText('maria@example.com')).toBeInTheDocument();
    expect(screen.getByText('Participante')).toBeInTheDocument();
    expect(screen.getByText(/novembro de 2026/)).toBeInTheDocument();
    expect(screen.getByLabelText('Nome completo')).toHaveValue('Maria Silva');
    expect(screen.queryByText('Carregando perfil…')).not.toBeInTheDocument();
  });

  it('atualiza o nome (PATCH só com name), confirma e reflete no cabeçalho', async () => {
    const f = fakeFetch({
      [LOGIN]: login,
      [ME]: () => jsonResponse(200, profile()),
      [PATCH_ME]: () => jsonResponse(200, profile({ name: 'Maria Souza' })),
    });
    const { user } = renderApp(f, '/perfil');
    await fillLogin(user);
    const input = await screen.findByLabelText('Nome completo');
    await user.clear(input);
    await user.type(input, '  Maria Souza ');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));

    expect(await screen.findByText('Perfil atualizado com sucesso.')).toBeInTheDocument();
    const patch = f.mock.calls.find((c) => c[1]?.method === 'PATCH')!;
    expect(JSON.parse(String(patch[1]?.body))).toEqual({ name: 'Maria Souza' });
    expect(headersOf(patch)['Authorization']).toBe('Bearer tok.en.value');
    expect(screen.getByLabelText('Usuário autenticado')).toHaveTextContent('Maria Souza');
  });

  it('valida o nome no cliente e não chama a API', async () => {
    const f = fakeFetch({ [LOGIN]: login, [ME]: () => jsonResponse(200, profile()) });
    const { user } = renderApp(f, '/perfil');
    await fillLogin(user);
    const input = await screen.findByLabelText('Nome completo');
    await user.clear(input);
    await user.type(input, 'a');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(
      await screen.findByText('Informe um nome com pelo menos 2 caracteres.'),
    ).toBeInTheDocument();
    expect(f.mock.calls.some((c) => c[1]?.method === 'PATCH')).toBe(false);
  });

  it('erro de validação do servidor no PATCH aparece no campo', async () => {
    const f = fakeFetch({
      [LOGIN]: login,
      [ME]: () => jsonResponse(200, profile()),
      [PATCH_ME]: () =>
        problem(400, 'VALIDATION_ERROR', 'Verifique os campos enviados.', {
          errors: [
            {
              field: 'name',
              message: 'Informe um nome entre 2 e 120 caracteres, sem caracteres de controle.',
            },
          ],
        }),
    });
    const { user } = renderApp(f, '/perfil');
    await fillLogin(user);
    const input = await screen.findByLabelText('Nome completo');
    await user.clear(input);
    await user.type(input, 'Novo Nome');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText(/sem caracteres de controle/)).toBeInTheDocument();
  });

  it('401 na consulta: encerra a sessão, volta ao login com aviso e NÃO entra em laço', async () => {
    const f = fakeFetch({
      [LOGIN]: login,
      [ME]: () => problem(401, 'UNAUTHENTICATED', 'Sessão ausente, inválida ou expirada.'),
    });
    const { user, services } = renderApp(f, '/perfil');
    await fillLogin(user);

    expect(await screen.findByText('Sua sessão expirou. Entre novamente.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(services.session.getToken()).toBeNull();
    const meCalls = f.mock.calls.filter((c) => String(c[0]).endsWith('/users/me'));
    expect(meCalls).toHaveLength(1);
  });

  it('401 ao salvar também encerra a sessão', async () => {
    const f = fakeFetch({
      [LOGIN]: login,
      [ME]: () => jsonResponse(200, profile()),
      [PATCH_ME]: () => problem(401, 'UNAUTHENTICATED', 'Sessão ausente, inválida ou expirada.'),
    });
    const { user } = renderApp(f, '/perfil');
    await fillLogin(user);
    const input = await screen.findByLabelText('Nome completo');
    await user.clear(input);
    await user.type(input, 'Outro Nome');
    await user.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(await screen.findByText('Sua sessão expirou. Entre novamente.')).toBeInTheDocument();
  });

  it('403: mostra acesso recusado e mantém a sessão (sem logout nem redirecionamento)', async () => {
    const f = fakeFetch({
      [LOGIN]: login,
      [ME]: () => problem(403, 'ACCESS_DENIED', 'Você não tem permissão para esta operação.'),
    });
    const { user, services } = renderApp(f, '/perfil');
    await fillLogin(user);
    expect(
      await screen.findByText('Você não tem permissão para esta operação.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sair' })).toBeInTheDocument();
    expect(services.session.getToken()).toBe('tok.en.value');
  });

  it('falha de rede mostra erro e permite tentar novamente', async () => {
    let attempts = 0;
    const f = fakeFetch({
      [LOGIN]: login,
      [ME]: () => {
        attempts += 1;
        if (attempts === 1) throw new TypeError('Failed to fetch');
        return jsonResponse(200, profile());
      },
    });
    const { user } = renderApp(f, '/perfil');
    await fillLogin(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível conectar ao servidor',
    );
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('maria@example.com')).toBeInTheDocument();
    expect(attempts).toBe(2);
  });

  it('erro do Gateway em texto puro (503) é tratado sem expor o corpo', async () => {
    const f = fakeFetch({ [LOGIN]: login, [ME]: () => textResponse(503, 'upstream exploded') });
    const { user } = renderApp(f, '/perfil');
    await fillLogin(user);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('temporariamente indisponível');
    expect(alert).not.toHaveTextContent('exploded');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sair' })).toBeInTheDocument());
  });
});
