import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ACTIVITY_ID, EVENT_ID, REGISTRATION_ID, activity, registration } from '../test/fixtures';
import {
  fakeFetch,
  headersOf,
  jsonResponse,
  loginBody,
  problem,
  signInTo,
  textResponse,
  type Handler,
} from '../test/helpers';

const LOGIN = 'POST /user/api/v1/auth/login';
const MINE = 'GET /subscription/api/v1/registrations/me';
const ACTIVITY = `GET /events/api/v1/activities/${ACTIVITY_ID}`;
const CANCEL = `POST /subscription/api/v1/registrations/${REGISTRATION_ID}/cancel`;
const ACCEPT = `POST /subscription/api/v1/registrations/${REGISTRATION_ID}/accept-offer`;

const base = (regs: unknown[], extra: Record<string, Handler> = {}) => ({
  [LOGIN]: () => jsonResponse(200, loginBody()),
  [MINE]: () => jsonResponse(200, { registrations: regs }),
  [ACTIVITY]: () => jsonResponse(200, activity()),
  ...extra,
});

const open = (f: ReturnType<typeof fakeFetch>) => signInTo(f, '/inscricoes');

describe('Minhas inscrições', () => {
  it('lista as inscrições com o nome da atividade, situação, valor e link para o evento', async () => {
    const f = fakeFetch(base([registration({ status: 'CONFIRMED' })]));
    await open(f);
    expect(await screen.findByRole('heading', { name: 'Oficina de React' })).toBeInTheDocument();
    expect(screen.getByText('Confirmada')).toBeInTheDocument();
    expect(screen.getByText(/R\$\s?50,00/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver evento' })).toHaveAttribute(
      'href',
      `/eventos/${EVENT_ID}`,
    );
    // A data no formato do Python ("2026-11-03 23:25:45+00:00") aparece formatada, não crua.
    expect(screen.getByText(/Inscrição feita em .*novembro de 2026/)).toBeInTheDocument();
    expect(screen.queryByText(/23:25:45\.175467\+00:00/)).not.toBeInTheDocument();
    const mine = f.mock.calls.find((c) => String(c[0]).includes('/registrations/me'))!;
    expect(headersOf(mine)['Authorization']).toBe('Bearer tok.en.value');
    expect(Object.fromEntries(new URL(String(mine[0])).searchParams)).toEqual({
      limit: '20',
      offset: '0',
    });
  });

  it('estado vazio com atalho para explorar eventos', async () => {
    await open(fakeFetch(base([])));
    expect(await screen.findByText('Você ainda não tem inscrições.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Explorar eventos' })).toHaveAttribute(
      'href',
      '/eventos',
    );
  });

  it('se Eventos falhar, a inscrição aparece mesmo assim, com identificação curta', async () => {
    const f = fakeFetch(
      base([registration()], { [ACTIVITY]: () => problem(503, 'AUTH_UNAVAILABLE', 'x') }),
    );
    await open(f);
    expect(
      await screen.findByRole('heading', { name: `Atividade ${ACTIVITY_ID.slice(0, 8)}` }),
    ).toBeInTheDocument();
    expect(screen.getByText('Confirmada')).toBeInTheDocument();
  });

  it('mostra o prazo para vagas oferecidas e pagamentos pendentes', async () => {
    const f = fakeFetch(
      base([registration({ status: 'PENDING_PAYMENT', expires_at: '2099-03-09 12:00:00+00:00' })]),
    );
    await open(f);
    expect(await screen.findByText('Aguardando pagamento')).toBeInTheDocument();
    expect(screen.getByText(/Prazo: .*2099/)).toBeInTheDocument();
  });

  it('cancelar exige confirmação; "Voltar" desiste sem chamar a API', async () => {
    const f = fakeFetch(
      base([registration()], {
        [CANCEL]: () => jsonResponse(200, registration({ status: 'CANCELLED' })),
      }),
    );
    const { user } = await open(f);
    await user.click(await screen.findByRole('button', { name: 'Cancelar inscrição' }));
    await user.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.getByRole('button', { name: 'Cancelar inscrição' })).toBeInTheDocument();
    expect(
      f.mock.calls.some((c) => c[1]?.method === 'POST' && String(c[0]).endsWith('/cancel')),
    ).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Cancelar inscrição' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar cancelamento' }));
    expect(await screen.findByText('Cancelada')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Cancelar inscrição|Confirmar cancelamento/ }),
    ).not.toBeInTheDocument();
    const post = f.mock.calls.find((c) => String(c[0]).endsWith('/cancel'))!;
    expect(post[1]?.method).toBe('POST');
    expect(headersOf(post)['Authorization']).toBe('Bearer tok.en.value');
  });

  it('aceitar uma oferta atualiza a situação', async () => {
    const f = fakeFetch(
      base([registration({ status: 'OFFERED', expires_at: '2099-03-09 12:00:00+00:00' })], {
        [ACCEPT]: () =>
          jsonResponse(
            200,
            registration({ status: 'PENDING_PAYMENT', expires_at: '2099-03-10 12:00:00+00:00' }),
          ),
      }),
    );
    const { user } = await open(f);
    expect(await screen.findByText('Vaga oferecida')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Aceitar oferta' }));
    expect(await screen.findByText('Aguardando pagamento')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aceitar oferta' })).not.toBeInTheDocument();
  });

  it('inscrições encerradas (canceladas, expiradas, recusadas) não oferecem ações', async () => {
    const regs = ['CANCELLED', 'EXPIRED', 'REJECTED'].map((status, i) =>
      registration({ id: `33333333-3333-4333-8333-00000000000${i}`, status }),
    );
    await open(fakeFetch(base(regs)));
    await screen.findByText('Expirada');
    expect(screen.getByText('Recusada')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Cancelar inscrição|Aceitar oferta/ }),
    ).not.toBeInTheDocument();
  });

  it('erro ao cancelar aparece em português e a inscrição permanece', async () => {
    const f = fakeFetch(
      base([registration()], { [CANCEL]: () => problem(409, 'INVALID_STATUS', 'bad state') }),
    );
    const { user } = await open(f);
    await user.click(await screen.findByRole('button', { name: 'Cancelar inscrição' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar cancelamento' }));
    expect(
      await screen.findByText('Esta operação não é permitida no estado atual.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Confirmada')).toBeInTheDocument();
  });

  it('401 em qualquer chamada encerra a sessão e volta ao login com o aviso', async () => {
    const f = fakeFetch(base([], { [MINE]: () => textResponse(401, 'unauthorized') }));
    const { services } = await open(f);
    expect(await screen.findByText('Sua sessão expirou. Entre novamente.')).toBeInTheDocument();
    expect(services.session.getToken()).toBeNull();
    expect(f.mock.calls.filter((c) => String(c[0]).includes('/registrations/me'))).toHaveLength(1);
  });

  it('falha de rede mostra erro e permite tentar novamente', async () => {
    let n = 0;
    const f = fakeFetch(
      base([registration()], {
        [MINE]: () => {
          n += 1;
          if (n === 1) throw new TypeError('Failed to fetch');
          return jsonResponse(200, { registrations: [registration()] });
        },
      }),
    );
    const { user } = await open(f);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Não foi possível conectar ao servidor',
    );
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Confirmada')).toBeInTheDocument();
  });

  it('paginação por deslocamento: página cheia habilita "Próxima" e a seguinte usa offset=20', async () => {
    const full = Array.from({ length: 20 }, (_, i) =>
      registration({ id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}` }),
    );
    const f = fakeFetch(
      base([], {
        [MINE]: ({ url }) =>
          jsonResponse(200, {
            registrations:
              url.searchParams.get('offset') === '20'
                ? [registration({ id: '33333333-3333-4333-8333-0000000000ff' })]
                : full,
          }),
      }),
    );
    const { user } = await open(f);
    await screen.findByText('Página 1');
    expect(screen.getByRole('button', { name: 'Anterior' })).toBeDisabled();
    expect(within(screen.getByRole('main')).getAllByRole('heading', { level: 2 })).toHaveLength(20);

    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(await screen.findByText('Página 2')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled());
    expect(
      new URL(
        String(f.mock.calls.filter((c) => String(c[0]).includes('/registrations/me')).at(-1)![0]),
      ).searchParams.get('offset'),
    ).toBe('20');
  });
});
