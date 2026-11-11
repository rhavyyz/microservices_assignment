import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { fakeFetch, jsonResponse, problem, profile, renderApp } from '../test/helpers';

const REGISTER = 'POST /user/api/v1/auth/register';

async function fillRegister(
  user: ReturnType<typeof userEvent.setup>,
  v: { name?: string; email?: string; password?: string; confirm?: string } = {},
) {
  await user.type(screen.getByLabelText('Nome completo'), v.name ?? 'Maria Silva');
  await user.type(screen.getByLabelText('E-mail'), v.email ?? 'maria@example.com');
  await user.type(screen.getByLabelText('Senha'), v.password ?? 'senha-forte-123');
  await user.type(
    screen.getByLabelText('Confirmar senha'),
    v.confirm ?? v.password ?? 'senha-forte-123',
  );
}

describe('Página de cadastro', () => {
  it('mostra os erros de validação e não chama a API', async () => {
    const f = fakeFetch({});
    const { user } = renderApp(f, '/cadastro');
    await user.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(
      await screen.findByText('Informe um nome com pelo menos 2 caracteres.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Informe o e-mail.')).toBeInTheDocument();
    expect(screen.getByLabelText('E-mail')).toHaveAttribute('aria-invalid', 'true');
    expect(f).not.toHaveBeenCalled();
  });

  it('valida senha curta e confirmação diferente', async () => {
    const f = fakeFetch({});
    const { user } = renderApp(f, '/cadastro');
    await fillRegister(user, { password: 'curta', confirm: 'outra' });
    await user.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(
      await screen.findByText('A senha deve ter pelo menos 10 caracteres.'),
    ).toBeInTheDocument();
    expect(screen.getByText('As senhas não conferem.')).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });

  it('cadastra, envia só nome, e-mail e senha, e leva ao login com aviso de sucesso', async () => {
    const f = fakeFetch({ [REGISTER]: () => jsonResponse(201, profile()) });
    const { user } = renderApp(f, '/cadastro');
    await fillRegister(user);
    await user.click(screen.getByRole('button', { name: 'Cadastrar' }));

    expect(await screen.findByRole('heading', { name: 'Entrar' })).toBeInTheDocument();
    expect(
      screen.getByText('Cadastro realizado. Entre com seu e-mail e senha.'),
    ).toBeInTheDocument();
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe('https://gateway.test/user/api/v1/auth/register');
    expect(JSON.parse(String(init?.body))).toEqual({
      name: 'Maria Silva',
      email: 'maria@example.com',
      password: 'senha-forte-123',
      requestedRole: 'PARTICIPANT',
    });
  });

  it('escolher "Organizador" envia o pedido e avisa que falta a aprovação de um administrador', async () => {
    const f = fakeFetch({
      [REGISTER]: () => jsonResponse(201, profile({ organizerRequest: 'PENDING' })),
    });
    const { user } = renderApp(f, '/cadastro');
    await fillRegister(user);
    await user.click(screen.getByLabelText('Organizador'));
    await user.click(screen.getByRole('button', { name: 'Cadastrar' }));

    expect(await screen.findByText(/aguarda a aprovação de um administrador/)).toBeInTheDocument();
    const [, init] = f.mock.calls[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({ requestedRole: 'ORGANIZER' });
  });

  it('o cadastro oferece só Participante e Organizador (nunca Administrador) e começa em Participante', () => {
    renderApp(fakeFetch({}), '/cadastro');
    expect(screen.getByLabelText('Participante')).toBeChecked();
    expect(screen.getByLabelText('Organizador')).not.toBeChecked();
    expect(screen.queryByLabelText(/Administrador/)).not.toBeInTheDocument();
  });

  it('e-mail já cadastrado (409) aparece no campo e mantém a página', async () => {
    const f = fakeFetch({
      [REGISTER]: () =>
        problem(
          409,
          'EMAIL_ALREADY_REGISTERED',
          'Não foi possível concluir o cadastro com este e-mail.',
        ),
    });
    const { user } = renderApp(f, '/cadastro');
    await fillRegister(user);
    await user.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(
      await screen.findByText('Não foi possível concluir o cadastro com este e-mail.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Criar conta' })).toBeInTheDocument();
  });

  it('erros de validação do servidor voltam para o campo certo', async () => {
    const f = fakeFetch({
      [REGISTER]: () =>
        problem(400, 'VALIDATION_ERROR', 'Verifique os campos enviados.', {
          errors: [{ field: 'password', message: 'A senha deve ter entre 10 e 72 caracteres.' }],
        }),
    });
    const { user } = renderApp(f, '/cadastro');
    await fillRegister(user);
    await user.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(
      await screen.findByText('A senha deve ter entre 10 e 72 caracteres.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Senha')).toHaveAttribute('aria-invalid', 'true');
  });

  it('falha de rede mostra mensagem amigável', async () => {
    const f = fakeFetch({
      [REGISTER]: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    const { user } = renderApp(f, '/cadastro');
    await fillRegister(user);
    await user.click(screen.getByRole('button', { name: 'Cadastrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível conectar ao servidor',
    );
  });

  it('erro 500 mostra texto genérico e o código de suporte, sem detalhes técnicos', async () => {
    const f = fakeFetch({
      [REGISTER]: () => problem(500, 'INTERNAL_ERROR', 'java.lang.NullPointerException'),
    });
    const { user } = renderApp(f, '/cadastro');
    await fillRegister(user);
    await user.click(screen.getByRole('button', { name: 'Cadastrar' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Ocorreu um erro inesperado');
    expect(alert).toHaveTextContent('Código de suporte: trace-abc-12345');
    expect(alert).not.toHaveTextContent('NullPointerException');
  });

  it('impede envio duplicado enquanto a requisição está em andamento', async () => {
    let release: (r: Response) => void = () => undefined;
    const f = fakeFetch({
      [REGISTER]: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    const { user } = renderApp(f, '/cadastro');
    await fillRegister(user);
    await user.click(screen.getByRole('button', { name: 'Cadastrar' }));

    const busy = await screen.findByRole('button', { name: 'Cadastrando…' });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(f).toHaveBeenCalledTimes(1);

    release(jsonResponse(201, profile()));
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Entrar' })).toBeInTheDocument(),
    );
    expect(f).toHaveBeenCalledTimes(1);
  });
});
