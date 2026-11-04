import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { safeRedirectPath } from './auth/redirect';
import { fakeFetch, fillLogin, jsonResponse, loginBody, profile, renderApp } from './test/helpers';

const LOGIN = 'POST /user/api/v1/auth/login';
const ME = 'GET /user/api/v1/users/me';
const SEARCH = 'GET /user/api/v1/users';

function routesFor(roles: string[]) {
  return {
    [LOGIN]: () => jsonResponse(200, loginBody(roles)),
    [ME]: () => jsonResponse(200, profile({ roles })),
    [SEARCH]: () =>
      jsonResponse(200, { items: [], page: 0, size: 10, totalElements: 0, totalPages: 0 }),
  };
}

describe('Rotas e guardas (só experiência de navegação; o backend autoriza de fato)', () => {
  it('rota protegida sem sessão leva ao login, sem chamar a API', async () => {
    const f = fakeFetch({});
    renderApp(f, '/perfil');
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });

  it('a página de busca também exige sessão', async () => {
    renderApp(fakeFetch({}), '/usuarios');
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
  });

  it('a raiz leva ao login (visitante) e o endereço inexistente mostra 404', async () => {
    const { unmount } = renderApp(fakeFetch({}), '/');
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    unmount();
    renderApp(fakeFetch({}), '/nao-existe');
    expect(
      await screen.findByRole('heading', { name: 'Página não encontrada' }),
    ).toBeInTheDocument();
  });

  it('participante vê "acesso negado" na busca, sem nenhuma chamada à API de busca', async () => {
    const f = fakeFetch(routesFor(['PARTICIPANT']));
    const { user } = renderApp(f, '/usuarios');
    await fillLogin(user);
    expect(await screen.findByRole('heading', { name: 'Acesso negado' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Usuários' })).not.toBeInTheDocument();
    expect(f.mock.calls.some((c) => String(c[0]).endsWith('/user/api/v1/users'))).toBe(false);
  });

  it('organizador vê o link e acessa a busca', async () => {
    const { user } = renderApp(fakeFetch(routesFor(['PARTICIPANT', 'ORGANIZER'])), '/entrar');
    await fillLogin(user);
    expect(await screen.findByRole('link', { name: 'Usuários' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Usuários' }));
    expect(await screen.findByRole('heading', { name: 'Buscar usuários' })).toBeInTheDocument();
  });

  it('quem já tem sessão não fica preso em /entrar nem /cadastro', async () => {
    const { user } = renderApp(fakeFetch(routesFor(['PARTICIPANT'])), '/entrar');
    await fillLogin(user);
    expect(await screen.findByRole('heading', { name: 'Meu perfil' })).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'EventHub' }));
    expect(await screen.findByRole('heading', { name: 'Meu perfil' })).toBeInTheDocument();
  });

  it('logout descarta o token da memória e volta ao login; a rota protegida volta a exigir login', async () => {
    const f = fakeFetch(routesFor(['PARTICIPANT']));
    const { user, services } = renderApp(f, '/entrar');
    await fillLogin(user);
    await screen.findByRole('heading', { name: 'Meu perfil' });
    expect(services.session.getToken()).toBe('tok.en.value');

    await user.click(screen.getByRole('button', { name: 'Sair' }));
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(services.session.getToken()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sair' })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('link', { name: 'Cadastrar' })).toBeInTheDocument(),
    );
  });
});

describe('safeRedirectPath', () => {
  it('só aceita caminhos internos', () => {
    expect(safeRedirectPath('/perfil')).toBe('/perfil');
    expect(safeRedirectPath('/usuarios?x=1')).toBe('/usuarios?x=1');
    for (const bad of [
      '//evil.com',
      'https://evil.com',
      '\\evil',
      '/\\evil',
      undefined,
      42,
      '/entrar',
      '/cadastro',
    ]) {
      expect(safeRedirectPath(bad)).toBe('/perfil');
    }
  });
});
