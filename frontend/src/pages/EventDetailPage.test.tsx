import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_ID,
  EVENT_ID,
  activity,
  availability,
  event,
  eventDetail,
  registration,
} from '../test/fixtures';
import {
  fakeFetch,
  headersOf,
  jsonResponse,
  loginBody,
  problem,
  renderApp,
  signInTo,
  textResponse,
  type Handler,
} from '../test/helpers';

const LOGIN = 'POST /user/api/v1/auth/login';
const DETAIL = `GET /events/api/v1/events/${EVENT_ID}`;
const MINE = 'GET /subscription/api/v1/registrations/me';
const AVAIL = `GET /subscription/api/v1/activities/${ACTIVITY_ID}/availability`;
const CREATE = `POST /subscription/api/v1/activities/${ACTIVITY_ID}/registrations`;
const PATH = `/eventos/${EVENT_ID}`;

const base = (extra: Record<string, Handler> = {}) => ({
  [LOGIN]: () => jsonResponse(200, loginBody()),
  [DETAIL]: () => jsonResponse(200, eventDetail()),
  [MINE]: () => jsonResponse(200, { registrations: [] }),
  [AVAIL]: () => jsonResponse(200, availability()),
  ...extra,
});

describe('Detalhe do evento (visitante)', () => {
  it('mostra o evento e as atividades, e convida o visitante a entrar, sem chamar a API de inscrições', async () => {
    const f = fakeFetch({ [DETAIL]: () => jsonResponse(200, eventDetail()) });
    renderApp(f, PATH);
    expect(
      await screen.findByRole('heading', { name: 'Semana de Tecnologia' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Universidade Exemplo')).toBeInTheDocument();
    expect(screen.getByText('Campus Central')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Oficina de React' })).toBeInTheDocument();
    expect(screen.getByText('Com Ana Souza')).toBeInTheDocument();
    // Visitante: só a capacidade (as vagas livres vêm de Inscrições e exigem login).
    expect(screen.getByText(/R\$\s?50,00 · 30 vagas no total/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Entre para se inscrever' })).toBeInTheDocument();
    expect(f.mock.calls).toHaveLength(1);
    expect(headersOf(f.mock.calls[0])['Authorization']).toBeUndefined();
  });

  it('id que não é UUID mostra "não encontrada" sem chamar a API', async () => {
    const f = fakeFetch({});
    renderApp(f, '/eventos/nao-e-uuid');
    expect(
      await screen.findByRole('heading', { name: 'Página não encontrada' }),
    ).toBeInTheDocument();
    expect(f).not.toHaveBeenCalled();
  });

  it('evento inexistente (404) mostra "não encontrada"', async () => {
    const f = fakeFetch({ [DETAIL]: () => problem(404, 'NOT_FOUND', 'event not found') });
    renderApp(f, PATH);
    expect(
      await screen.findByRole('heading', { name: 'Página não encontrada' }),
    ).toBeInTheDocument();
  });

  it('erro do servidor mostra mensagem genérica com código de suporte e permite tentar de novo', async () => {
    let n = 0;
    const f = fakeFetch({
      [DETAIL]: () => {
        n += 1;
        return n === 1
          ? problem(500, 'INTERNAL_ERROR', 'stack trace')
          : jsonResponse(200, eventDetail());
      },
    });
    const { user } = renderApp(f, PATH);
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Código de suporte: trace-abc-12345');
    expect(alert).not.toHaveTextContent('stack trace');
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await screen.findByRole('heading', { name: 'Semana de Tecnologia' }),
    ).toBeInTheDocument();
  });

  it('banner: só https, sem referrer; http é ignorado', async () => {
    const { container, unmount } = renderApp(
      fakeFetch({
        [DETAIL]: () =>
          jsonResponse(200, eventDetail({ banner_url: 'https://img.example.com/b.png' })),
      }),
      PATH,
    );
    await screen.findByRole('heading', { name: 'Semana de Tecnologia' });
    const img = container.querySelector('img.banner');
    expect(img).toHaveAttribute('src', 'https://img.example.com/b.png');
    expect(img).toHaveAttribute('referrerpolicy', 'no-referrer');
    unmount();
    const http = renderApp(
      fakeFetch({
        [DETAIL]: () =>
          jsonResponse(200, eventDetail({ banner_url: 'http://img.example.com/b.png' })),
      }),
      PATH,
    );
    await screen.findByRole('heading', { name: 'Semana de Tecnologia' });
    expect(http.container.querySelector('img')).toBeNull();
  });

  it('evento cancelado, atividade encerrada e evento já terminado impedem a inscrição, com aviso', async () => {
    const closed = { registration_open: false };
    const cancelled = renderApp(
      fakeFetch({
        [DETAIL]: () =>
          jsonResponse(
            200,
            eventDetail({ status: 'CANCELLED' }, [activity({ ...closed, lifecycle: 'CANCELLED' })]),
          ),
      }),
      PATH,
    );
    expect(await screen.findByText('Este evento foi cancelado.')).toBeInTheDocument();
    expect(screen.getByText('Atividade cancelada.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Inscrever-se' })).not.toBeInTheDocument();
    cancelled.unmount();

    const ended = renderApp(
      fakeFetch({
        [DETAIL]: () =>
          jsonResponse(
            200,
            eventDetail({ starts_at: '2000-01-01T10:00:00Z', ends_at: '2000-01-02T10:00:00Z' }, [
              activity({ ...closed, lifecycle: 'ENDED', ended_at: '2000-01-01T12:00:00Z' }),
            ]),
          ),
      }),
      PATH,
    );
    expect(await screen.findByText(/Este evento já terminou/)).toBeInTheDocument();
    expect(screen.getByText('Atividade encerrada.')).toBeInTheDocument();
    ended.unmount();

    // Aberta no calendário, mas sem inscrições abertas (ex.: já começou): mensagem genérica.
    renderApp(
      fakeFetch({ [DETAIL]: () => jsonResponse(200, eventDetail({}, [activity({ ...closed })])) }),
      PATH,
    );
    expect(await screen.findByText('Inscrições encerradas.')).toBeInTheDocument();
  });

  it('evento sem atividades mostra aviso', async () => {
    renderApp(fakeFetch({ [DETAIL]: () => jsonResponse(200, eventDetail({}, [])) }), PATH);
    expect(await screen.findByText('Este evento ainda não tem atividades.')).toBeInTheDocument();
  });
});

describe('Inscrição em uma atividade (autenticado)', () => {
  it('carrega as inscrições vivas com Bearer e marca a atividade já inscrita', async () => {
    const f = fakeFetch(
      base({
        [MINE]: () => jsonResponse(200, { registrations: [registration({ status: 'CONFIRMED' })] }),
      }),
    );
    await signInTo(f, PATH);
    expect(await screen.findByText('Confirmada')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Inscrever-se' })).not.toBeInTheDocument();
    const mine = f.mock.calls.find((c) => String(c[0]).includes('/registrations/me'));
    expect(headersOf(mine)['Authorization']).toBe('Bearer tok.en.value');
  });

  it('ignora inscrições canceladas: a pessoa pode se inscrever de novo', async () => {
    const f = fakeFetch(
      base({
        [MINE]: () => jsonResponse(200, { registrations: [registration({ status: 'CANCELLED' })] }),
      }),
    );
    await signInTo(f, PATH);
    expect(await screen.findByRole('button', { name: 'Inscrever-se' })).toBeInTheDocument();
  });

  it('inscreve (join_waitlist=false) e passa a mostrar a situação com o prazo de pagamento', async () => {
    const f = fakeFetch(
      base({
        [CREATE]: () =>
          jsonResponse(
            201,
            registration({ status: 'PENDING_PAYMENT', expires_at: '2099-03-09 12:00:00+00:00' }),
          ),
      }),
    );
    const { user } = await signInTo(f, PATH);
    await user.click(await screen.findByRole('button', { name: 'Inscrever-se' }));
    expect(await screen.findByText('Aguardando pagamento')).toBeInTheDocument();
    expect(screen.getByText(/conclua o pagamento/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Inscrever-se' })).not.toBeInTheDocument();
    const post = f.mock.calls.find(
      (c) => c[1]?.method === 'POST' && String(c[0]).endsWith('/registrations'),
    )!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ join_waitlist: false });
    expect(headersOf(post)['Authorization']).toBe('Bearer tok.en.value');
  });

  it('sem vagas e com lista de espera: o botão entra na lista (join_waitlist=true)', async () => {
    const f = fakeFetch(
      base({
        [AVAIL]: () => jsonResponse(200, availability({ available: 0 })),
        [CREATE]: () => jsonResponse(201, registration({ status: 'WAITLISTED' })),
      }),
    );
    const { user } = await signInTo(f, PATH);
    expect(await screen.findByText(/sem vagas \(lista de espera disponível\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Entrar na lista de espera' }));
    expect(await screen.findByText('Na lista de espera')).toBeInTheDocument();
    const post = f.mock.calls.find(
      (c) => c[1]?.method === 'POST' && String(c[0]).endsWith('/registrations'),
    )!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ join_waitlist: true });
  });

  it('sem vagas e sem lista de espera: "Esgotado", sem botão', async () => {
    const f = fakeFetch(
      base({
        [DETAIL]: () => jsonResponse(200, eventDetail({}, [activity({ waitlist_enabled: false })])),
        [AVAIL]: () => jsonResponse(200, availability({ available: 0 })),
      }),
    );
    await signInTo(f, PATH);
    expect(await screen.findByText('Esgotado.')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toHaveTextContent('Sair'); // só o botão do menu
  });

  it('erros do servidor aparecem em português, sem expor o texto técnico', async () => {
    let code = 'ACTIVITY_FULL';
    const f = fakeFetch(
      base({
        [CREATE]: () => problem(code === 'ACTIVITY_FULL' ? 409 : 503, code, 'raw english detail'),
      }),
    );
    const { user } = await signInTo(f, PATH);
    await user.click(await screen.findByRole('button', { name: 'Inscrever-se' }));
    expect(await screen.findByText('A atividade está lotada.')).toBeInTheDocument();
    // Lotação descoberta ao tentar: como há lista de espera, o botão passa a oferecê-la.
    expect(screen.getByText(/sem vagas \(lista de espera disponível\)/)).toBeInTheDocument();

    code = 'INVALID_EVENTS_CONTRACT';
    await user.click(screen.getByRole('button', { name: 'Entrar na lista de espera' }));
    expect(await screen.findByText(/serviço necessário está indisponível/)).toBeInTheDocument();
    expect(screen.queryByText(/raw english detail/)).not.toBeInTheDocument();
    expect(screen.getByText('Código de suporte: trace-abc-12345')).toBeInTheDocument();
  });

  it('mostra as vagas livres informadas por Inscrições (com Bearer) e só consulta as atividades abertas', async () => {
    const f = fakeFetch(base());
    await signInTo(f, PATH);
    expect(await screen.findByText(/R\$\s?50,00 · 12 de 30 vagas/)).toBeInTheDocument();
    const call = f.mock.calls.find((c) => String(c[0]).endsWith('/availability'))!;
    expect(headersOf(call)['Authorization']).toBe('Bearer tok.en.value');
  });

  it('se as vagas não puderem ser consultadas, mostra a capacidade e mantém a inscrição possível', async () => {
    const f = fakeFetch(base({ [AVAIL]: () => problem(503, 'DEPENDENCY_UNAVAILABLE', 'down') }));
    await signInTo(f, PATH);
    expect(await screen.findByText(/30 vagas no total/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inscrever-se' })).toBeInTheDocument();
  });

  it('impede cliques repetidos enquanto a inscrição é enviada', async () => {
    let release: (r: Response) => void = () => undefined;
    const f = fakeFetch(base({ [CREATE]: () => new Promise<Response>((r) => (release = r)) }));
    const { user } = await signInTo(f, PATH);
    await user.click(await screen.findByRole('button', { name: 'Inscrever-se' }));
    const busy = await screen.findByRole('button', { name: 'Inscrevendo…' });
    expect(busy).toBeDisabled();
    await user.click(busy);
    release(jsonResponse(201, registration({ status: 'CONFIRMED' })));
    expect(await screen.findByText('Confirmada')).toBeInTheDocument();
    expect(
      f.mock.calls.filter(
        (c) => c[1]?.method === 'POST' && String(c[0]).endsWith('/registrations'),
      ),
    ).toHaveLength(1);
  });

  it('sessão expirada ao inscrever (401 do Gateway em texto puro) encerra a sessão e volta a pedir login', async () => {
    const f = fakeFetch(base({ [CREATE]: () => textResponse(401, 'unauthorized') }));
    const { user, services } = await signInTo(f, PATH);
    await user.click(await screen.findByRole('button', { name: 'Inscrever-se' }));
    await waitFor(() => expect(services.session.getToken()).toBeNull());
    expect(
      await screen.findByRole('link', { name: 'Entre para se inscrever' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sair' })).not.toBeInTheDocument();
  });

  it('se não der para carregar as inscrições, avisa e o evento continua utilizável', async () => {
    const f = fakeFetch(base({ [MINE]: () => problem(503, 'DEPENDENCY_UNAVAILABLE', 'down') }));
    await signInTo(f, PATH);
    expect(
      await screen.findByText(/Não foi possível carregar as suas inscrições/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Inscrever-se' })).toBeInTheDocument();
  });

  it('o evento do fixture continua publicado (garante que os testes acima não dependem do relógio)', () => {
    expect(event().ends_at.startsWith('2099')).toBe(true);
  });
});
