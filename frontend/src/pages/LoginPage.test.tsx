import { screen } from '@testing-library/react';
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

describe('Página de login', () => {
  it('valida e-mail e senha antes de chamar a API', async () => {
    const f = fakeFetch({});
    const { user } = renderApp(f, '/entrar');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByText('Informe o e-mail.')).toBeInTheDocument();
    expect(screen.getByText('Informe a senha.')).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });

  it('credenciais inválidas (401): mostra o erro, limpa a senha e NÃO redireciona nem repete a chamada', async () => {
    const f = fakeFetch({
      [LOGIN]: () => problem(401, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos.'),
    });
    const { user } = renderApp(f, '/entrar');
    await fillLogin(user);
    expect(await screen.findByText('E-mail ou senha incorretos.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(screen.getByLabelText('Senha')).toHaveValue('');
    expect(screen.getByLabelText('E-mail')).toHaveValue('maria@example.com');
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('login válido leva ao início, já autenticado', async () => {
    const f = fakeFetch({ [LOGIN]: () => jsonResponse(200, loginBody()) });
    const { user } = renderApp(f, '/entrar');
    await fillLogin(user);
    expect(await screen.findByRole('heading', { name: 'Início' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sair' })).toBeInTheDocument();
    expect(screen.getByLabelText('Usuário autenticado')).toHaveTextContent('Maria Silva');
  });

  it('volta ao destino original depois do login (rota protegida acessada sem sessão)', async () => {
    const f = fakeFetch({
      [LOGIN]: () => jsonResponse(200, loginBody()),
      [ME]: () => jsonResponse(200, profile()),
    });
    const { user } = renderApp(f, '/perfil');
    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    await fillLogin(user);
    expect(await screen.findByRole('heading', { name: 'Meu perfil' })).toBeInTheDocument();
    expect(await screen.findByText('maria@example.com')).toBeInTheDocument();
    const meCall = f.mock.calls.find((c) => String(c[0]).endsWith('/users/me'));
    expect(headersOf(meCall)['Authorization']).toBe('Bearer tok.en.value');
  });

  it('excesso de tentativas (429 do Gateway, texto puro) mostra mensagem clara', async () => {
    const f = fakeFetch({ [LOGIN]: () => textResponse(429, 'too many requests') });
    const { user } = renderApp(f, '/entrar');
    await fillLogin(user);
    expect(await screen.findByText(/Muitas requisições em pouco tempo/)).toBeInTheDocument();
  });

  it('Gateway indisponível (503) mostra mensagem clara', async () => {
    const f = fakeFetch({ [LOGIN]: () => textResponse(503, 'service unavailable') });
    const { user } = renderApp(f, '/entrar');
    await fillLogin(user);
    expect(await screen.findByText(/temporariamente indisponível/)).toBeInTheDocument();
  });

  it('resposta de login fora do contrato não cria sessão', async () => {
    const f = fakeFetch({ [LOGIN]: () => jsonResponse(200, { accessToken: 'x' }) });
    const { user } = renderApp(f, '/entrar');
    await fillLogin(user);
    expect(await screen.findByText(/erro inesperado/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
  });
});
