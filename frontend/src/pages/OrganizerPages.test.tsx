import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_ID,
  EVENT_ID,
  REGISTRATION_ID,
  activity,
  attendance,
  event,
  eventDetail,
  eventPage,
  registration,
} from '../test/fixtures';
import {
  USER_ID,
  fakeFetch,
  headersOf,
  jsonResponse,
  loginBody,
  problem,
  signInTo,
  type Handler,
} from '../test/helpers';

const LOGIN = 'POST /user/api/v1/auth/login';
const EV = '/events/api/v1';
const SUB = '/subscription/api/v1';
const ME_EVENTS = `GET ${EV}/me/events`;
const GET_EVENT = `GET ${EV}/events/${EVENT_ID}`;

const organizerLogin = { [LOGIN]: () => jsonResponse(200, loginBody(['ORGANIZER'])) };
const bodyOf = (call: unknown[] | undefined) =>
  JSON.parse(String((call?.[1] as RequestInit).body)) as Record<string, unknown>;
const callsTo = (f: ReturnType<typeof fakeFetch>, key: string) =>
  f.mock.calls.filter((c) => {
    const u = new URL(String(c[0]));
    return (
      `${((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase()} ${u.pathname}` === key
    );
  });
const setValue = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('Meus eventos (organizador)', () => {
  it('lista os eventos do usuário (rascunhos incluídos) com Bearer e link para gerenciar', async () => {
    const f = fakeFetch({
      ...organizerLogin,
      [ME_EVENTS]: () =>
        jsonResponse(
          200,
          eventPage([event({ status: 'DRAFT' }), event({ event_id: ACTIVITY_ID, title: 'Outro' })]),
        ),
    });
    await signInTo(f, '/organizador');
    expect(
      await screen.findByRole('heading', { name: 'Semana de Tecnologia' }),
    ).toBeInTheDocument();
    expect(screen.getByText('Rascunho')).toBeInTheDocument();
    expect(screen.getByText('Publicado')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: 'Gerenciar' })[0]).toHaveAttribute(
      'href',
      `/organizador/eventos/${EVENT_ID}`,
    );
    expect(screen.getByRole('link', { name: 'Novo evento' })).toHaveAttribute(
      'href',
      '/organizador/novo',
    );
    expect(headersOf(callsTo(f, ME_EVENTS)[0])['Authorization']).toBe('Bearer tok.en.value');
  });

  it('falha mostra o erro e "Tentar novamente" refaz a chamada', async () => {
    let n = 0;
    const f = fakeFetch({
      ...organizerLogin,
      [ME_EVENTS]: () =>
        ++n === 1
          ? problem(503, 'DEPENDENCY_UNAVAILABLE', 'x')
          : jsonResponse(200, eventPage([event()])),
    });
    const { user } = await signInTo(f, '/organizador');
    expect(await screen.findByRole('alert')).toHaveTextContent(/indisponível/);
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await screen.findByRole('heading', { name: 'Semana de Tecnologia' }),
    ).toBeInTheDocument();
  });

  it('estado vazio', async () => {
    const f = fakeFetch({ ...organizerLogin, [ME_EVENTS]: () => jsonResponse(200, eventPage([])) });
    await signInTo(f, '/organizador');
    expect(await screen.findByText('Você ainda não criou eventos.')).toBeInTheDocument();
  });

  it('paginação usa o total: "Próxima" só existe se há mais eventos', async () => {
    const f = fakeFetch({
      ...organizerLogin,
      [ME_EVENTS]: ({ url }) =>
        jsonResponse(200, eventPage([event()], 21, Number(url.searchParams.get('offset')))),
    });
    const { user } = await signInTo(f, '/organizador');
    await screen.findByRole('heading', { name: 'Semana de Tecnologia' });
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    await waitFor(() => expect(callsTo(f, ME_EVENTS).at(-1)).toBeDefined());
    await waitFor(() =>
      expect(new URL(String(callsTo(f, ME_EVENTS).at(-1)![0])).searchParams.get('offset')).toBe(
        '20',
      ),
    );
    await waitFor(() => expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled());
  });
});

describe('Novo evento', () => {
  it('valida antes de enviar e não chama a API com dados inválidos', async () => {
    const f = fakeFetch({ ...organizerLogin });
    const { user } = await signInTo(f, '/organizador/novo');
    await user.click(await screen.findByRole('button', { name: 'Criar evento' }));
    expect(await screen.findByText('Informe o título.')).toBeInTheDocument();
    expect(callsTo(f, `POST ${EV}/events`)).toHaveLength(0);
  });

  it('cria o rascunho com o contrato certo e leva à página de gestão', async () => {
    const f = fakeFetch({
      ...organizerLogin,
      [`POST ${EV}/events`]: () => jsonResponse(201, event({ status: 'DRAFT' })),
      [GET_EVENT]: () => jsonResponse(200, eventDetail({ status: 'DRAFT' }, [])),
    });
    const { user } = await signInTo(f, '/organizador/novo');
    await screen.findByRole('heading', { name: 'Novo evento' });
    setValue('Título', 'Semana de Tecnologia');
    setValue('Início', '2099-03-10T09:00');
    setValue('Término', '2099-03-12T18:00');
    await user.click(screen.getByRole('button', { name: 'Criar evento' }));
    expect(await screen.findByRole('link', { name: '← Meus eventos' })).toBeInTheDocument();
    const call = callsTo(f, `POST ${EV}/events`)[0];
    expect(bodyOf(call)).toEqual({
      title: 'Semana de Tecnologia',
      organization: null,
      description: null,
      location: null,
      banner_url: null,
      starts_at: new Date('2099-03-10T09:00').toISOString(),
      ends_at: new Date('2099-03-12T18:00').toISOString(),
    });
    expect(headersOf(call)['Authorization']).toBe('Bearer tok.en.value');
  });

  it('erro de regra do servidor (período inválido) aparece traduzido, sem sair da página', async () => {
    const f = fakeFetch({
      ...organizerLogin,
      [`POST ${EV}/events`]: () =>
        problem(422, 'INVALID_PERIOD', 'starts_at must be before ends_at'),
    });
    const { user } = await signInTo(f, '/organizador/novo');
    await screen.findByRole('heading', { name: 'Novo evento' });
    setValue('Título', 'X');
    setValue('Início', '2099-03-10T09:00');
    setValue('Término', '2099-03-12T18:00');
    await user.click(screen.getByRole('button', { name: 'Criar evento' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('O período informado é inválido.');
    expect(screen.getByRole('heading', { name: 'Novo evento' })).toBeInTheDocument();
  });
});

describe('Gerenciar evento', () => {
  const PUBLISH = `POST ${EV}/events/${EVENT_ID}/publish`;
  const CANCEL = `POST ${EV}/events/${EVENT_ID}/cancel`;
  const ADD = `POST ${EV}/events/${EVENT_ID}/activities`;
  const PATCH_ACT = `PATCH ${EV}/activities/${ACTIVITY_ID}`;
  const END = `POST ${EV}/activities/${ACTIVITY_ID}/end`;
  const DELETE = `DELETE ${EV}/activities/${ACTIVITY_ID}`;

  async function manage(detail: () => unknown, extra: Record<string, Handler> = {}) {
    const f = fakeFetch({
      ...organizerLogin,
      [GET_EVENT]: () => jsonResponse(200, detail()),
      ...extra,
    });
    const ctx = await signInTo(f, `/organizador/eventos/${EVENT_ID}`);
    await screen.findByRole('heading', { name: 'Semana de Tecnologia' });
    return { f, ...ctx };
  }

  it('lê o evento COM token (o dono enxerga o rascunho) e mostra as atividades', async () => {
    const { f } = await manage(() => eventDetail({ status: 'DRAFT' }));
    expect(headersOf(callsTo(f, GET_EVENT)[0])['Authorization']).toBe('Bearer tok.en.value');
    expect(screen.getByRole('heading', { name: 'Oficina de React' })).toBeInTheDocument();
    expect(screen.getByText('Rascunho')).toBeInTheDocument();
  });

  it('rascunho sem atividades: avisa e o serviço recusa publicar (mensagem traduzida)', async () => {
    const { user } = await manage(() => eventDetail({ status: 'DRAFT' }, []), {
      [PUBLISH]: () => problem(409, 'EVENT_WITHOUT_ACTIVITIES', 'event needs an activity'),
    });
    expect(screen.getByText(/ao menos uma atividade para poder publicar/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publicar evento' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Adicione ao menos uma atividade antes de publicar.',
    );
  });

  it('publica o rascunho e recarrega o evento já publicado', async () => {
    let status = 'DRAFT';
    const { user, f } = await manage(() => eventDetail({ status }), {
      [PUBLISH]: () => {
        status = 'PUBLISHED';
        return jsonResponse(200, event({ status }));
      },
    });
    await user.click(screen.getByRole('button', { name: 'Publicar evento' }));
    expect(await screen.findByText('Evento publicado.')).toBeInTheDocument();
    expect(screen.getByText('Publicado')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Publicar evento' })).not.toBeInTheDocument();
    expect(callsTo(f, PUBLISH)).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Ver como participante' })).toBeInTheDocument();
  });

  it('cancelar exige confirmação; "Voltar" não chama a API; confirmar cancela', async () => {
    let status = 'PUBLISHED';
    const { user, f } = await manage(() => eventDetail({ status }), {
      [CANCEL]: () => {
        status = 'CANCELLED';
        return jsonResponse(200, event({ status }));
      },
    });
    await user.click(screen.getByRole('button', { name: 'Cancelar evento' }));
    expect(screen.getByText(/Cancelar é definitivo/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(callsTo(f, CANCEL)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Cancelar evento' }));
    await user.click(screen.getByRole('button', { name: 'Confirmar cancelamento do evento' }));
    expect(await screen.findByText('Evento cancelado.')).toBeInTheDocument();
    expect(screen.getByText('Cancelado')).toBeInTheDocument();
    // Evento cancelado: sem edição, sem publicar, sem nova atividade.
    expect(
      screen.queryByRole('button', { name: 'Editar dados do evento' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Adicionar atividade' })).not.toBeInTheDocument();
  });

  it('edita os dados do evento com PATCH e reflete o novo título', async () => {
    const { user, f } = await manage(() => eventDetail({ status: 'DRAFT' }), {
      [`PATCH ${EV}/events/${EVENT_ID}`]: () =>
        jsonResponse(200, event({ status: 'DRAFT', title: 'Novo título' })),
    });
    await user.click(screen.getByRole('button', { name: 'Editar dados do evento' }));
    expect(screen.getByLabelText('Título')).toHaveValue('Semana de Tecnologia');
    expect(screen.getByLabelText('Início')).toHaveValue(
      (() => {
        const d = new Date('2099-03-10T12:00:00.000Z');
        const p = (n: number) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
      })(),
    );
    setValue('Título', 'Novo título');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    expect(await screen.findByRole('heading', { name: 'Novo título' })).toBeInTheDocument();
    expect(bodyOf(callsTo(f, `PATCH ${EV}/events/${EVENT_ID}`)[0])).toMatchObject({
      title: 'Novo título',
    });
  });

  it('adiciona atividade: preço em centavos, capacidade numérica, lista de espera', async () => {
    const { user, f } = await manage(() => eventDetail({ status: 'DRAFT' }, []), {
      [ADD]: () =>
        jsonResponse(201, activity({ title: 'Palestra', amount_minor: 5050, capacity: 40 })),
    });
    await user.click(screen.getByRole('button', { name: 'Adicionar atividade' }));
    setValue('Título da atividade', 'Palestra');
    setValue('Início da atividade', '2099-03-10T10:00');
    setValue('Término da atividade', '2099-03-10T12:00');
    setValue('Valor da inscrição (R$)', '50,50');
    setValue('Capacidade', '40');
    await user.click(screen.getByLabelText('Permitir lista de espera'));
    await user.click(screen.getByRole('button', { name: /^Adicionar atividade$/, hidden: false }));
    expect(await screen.findByText('Atividade adicionada.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Palestra' })).toBeInTheDocument();
    expect(bodyOf(callsTo(f, ADD)[0])).toMatchObject({
      title: 'Palestra',
      amount_minor: 5050,
      capacity: 40,
      waitlist_enabled: true,
      starts_at: new Date('2099-03-10T10:00').toISOString(),
    });
  });

  it('atividade fora do período do evento: mensagem traduzida do serviço', async () => {
    const { user } = await manage(() => eventDetail({ status: 'DRAFT' }, []), {
      [ADD]: () => problem(422, 'ACTIVITY_OUTSIDE_EVENT', 'outside'),
    });
    await user.click(screen.getByRole('button', { name: 'Adicionar atividade' }));
    setValue('Título da atividade', 'Palestra');
    setValue('Início da atividade', '2099-04-10T10:00');
    setValue('Término da atividade', '2099-04-10T12:00');
    setValue('Capacidade', '40');
    await user.click(screen.getByRole('button', { name: /^Adicionar atividade$/ }));
    expect(
      await screen.findByText('A atividade deve ficar dentro do período do evento.'),
    ).toBeInTheDocument();
  });

  it('edita a atividade SEM enviar capacity; capacidade é só leitura; preço travado se publicado', async () => {
    const { user, f } = await manage(() => eventDetail({ status: 'PUBLISHED' }), {
      [PATCH_ACT]: () => jsonResponse(200, activity({ title: 'Oficina v2' })),
    });
    await user.click(screen.getByRole('button', { name: 'Editar atividade' }));
    expect(screen.getByLabelText('Capacidade')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Valor da inscrição (R$)')).toHaveAttribute('readonly');
    setValue('Título da atividade', 'Oficina v2');
    await user.click(screen.getByRole('button', { name: 'Salvar atividade' }));
    expect(await screen.findByRole('heading', { name: 'Oficina v2' })).toBeInTheDocument();
    const body = bodyOf(callsTo(f, PATCH_ACT)[0]);
    expect(body).toMatchObject({ title: 'Oficina v2', amount_minor: 5000 });
    expect(body).not.toHaveProperty('capacity');
  });

  it('remover atividade só em rascunho e com confirmação; DELETE 204 remove da lista', async () => {
    const { user, f } = await manage(() => eventDetail({ status: 'DRAFT' }), {
      [DELETE]: () => new Response(null, { status: 204 }),
    });
    await user.click(screen.getByRole('button', { name: 'Remover atividade' }));
    expect(callsTo(f, DELETE)).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Confirmar remoção' }));
    await waitFor(() =>
      expect(screen.queryByRole('heading', { name: 'Oficina de React' })).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Nenhuma atividade ainda.')).toBeInTheDocument();
  });

  it('o link do relatório só existe depois de publicado (rascunho não tem indicadores)', async () => {
    await manage(() => eventDetail({ status: 'DRAFT' }));
    expect(screen.queryByRole('link', { name: 'Ver relatório' })).not.toBeInTheDocument();
  });

  it('evento publicado liga ao relatório', async () => {
    await manage(() => eventDetail({ status: 'PUBLISHED' }));
    expect(screen.getByRole('link', { name: 'Ver relatório' })).toHaveAttribute(
      'href',
      `/organizador/eventos/${EVENT_ID}/relatorio`,
    );
  });

  it('em evento publicado não há "Remover"; há link de participantes', async () => {
    await manage(() => eventDetail({ status: 'PUBLISHED' }));
    expect(screen.queryByRole('button', { name: 'Remover atividade' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Participantes' })).toHaveAttribute(
      'href',
      `/organizador/atividades/${ACTIVITY_ID}/participantes`,
    );
  });

  it('"Encerrar atividade" só aparece depois do término previsto; encerra e mostra o estado', async () => {
    const past = activity({
      starts_at: '2000-01-01T10:00:00.000Z',
      ends_at: '2000-01-01T12:00:00.000Z',
    });
    const { user, f } = await manage(() => eventDetail({ status: 'PUBLISHED' }, [past]), {
      [END]: () =>
        jsonResponse(200, { ...past, lifecycle: 'ENDED', ended_at: '2000-01-01T12:05:00.000Z' }),
    });
    await user.click(screen.getByRole('button', { name: 'Encerrar atividade' }));
    expect(await screen.findByText('Encerrada')).toBeInTheDocument();
    expect(callsTo(f, END)).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Editar atividade' })).not.toBeInTheDocument();
  });

  it('atividade futura não oferece "Encerrar"', async () => {
    await manage(() => eventDetail({ status: 'PUBLISHED' }));
    expect(screen.queryByRole('button', { name: 'Encerrar atividade' })).not.toBeInTheDocument();
  });

  it('evento de outro organizador/inexistente (404) mostra "não encontrado"', async () => {
    const f = fakeFetch({
      ...organizerLogin,
      [GET_EVENT]: () => problem(404, 'NOT_FOUND', 'event not found'),
    });
    await signInTo(f, `/organizador/eventos/${EVENT_ID}`);
    expect(await screen.findByRole('heading', { name: /não encontrada/i })).toBeInTheDocument();
  });

  it('id que não é UUID nem chama a API', async () => {
    const f = fakeFetch({ ...organizerLogin });
    await signInTo(f, '/organizador/eventos/abc');
    expect(await screen.findByRole('heading', { name: /não encontrada/i })).toBeInTheDocument();
    expect(f.mock.calls.filter((c) => String(c[0]).includes('/events/'))).toHaveLength(0);
  });
});

describe('Participantes e check-in', () => {
  const PARTICIPANTS = `GET ${SUB}/activities/${ACTIVITY_ID}/registrations`;
  const CHECK_IN = `POST ${SUB}/registrations/${REGISTRATION_ID}/check-in`;
  const ACT = `GET ${EV}/activities/${ACTIVITY_ID}`;
  const SEARCH = 'GET /user/api/v1/users';
  const happening = activity({
    starts_at: '2000-01-01T10:00:00.000Z',
    ends_at: '2099-01-01T12:00:00.000Z',
  });

  const open = async (regs: unknown[], act: unknown, extra: Record<string, Handler> = {}) => {
    const f = fakeFetch({
      ...organizerLogin,
      [PARTICIPANTS]: () => jsonResponse(200, { registrations: regs }),
      [ACT]: () => jsonResponse(200, act),
      [SEARCH]: ({ url }) => {
        const found = url.searchParams.get('id') === USER_ID;
        const items = found
          ? [
              {
                id: USER_ID,
                name: 'Maria Silva',
                email: 'maria@example.com',
                roles: ['PARTICIPANT'],
                status: 'ACTIVE',
              },
            ]
          : [];
        return jsonResponse(200, {
          items,
          page: 0,
          size: 1,
          totalElements: items.length,
          totalPages: 1,
        });
      },
      ...extra,
    });
    return { f, ...(await signInTo(f, `/organizador/atividades/${ACTIVITY_ID}/participantes`)) };
  };

  it('lista participantes com nome/e-mail (busca por id) e situação, com Bearer', async () => {
    const { f } = await open([registration()], happening);
    expect(await screen.findByRole('heading', { name: 'Maria Silva' })).toBeInTheDocument();
    expect(screen.getByText('maria@example.com')).toBeInTheDocument();
    expect(screen.getByText('Confirmada')).toBeInTheDocument();
    expect(headersOf(callsTo(f, PARTICIPANTS)[0])['Authorization']).toBe('Bearer tok.en.value');
    expect(new URL(String(callsTo(f, SEARCH)[0]![0])).searchParams.get('id')).toBe(USER_ID);
  });

  it('se a busca de usuários falhar, mostra o participante pelo id curto', async () => {
    await open([registration()], happening, { [SEARCH]: () => problem(503, 'X', 'x') });
    expect(
      await screen.findByRole('heading', { name: `Usuário ${USER_ID.slice(0, 8)}` }),
    ).toBeInTheDocument();
    expect(screen.getByText('Confirmada')).toBeInTheDocument();
  });

  it('check-in: só para CONFIRMED durante a atividade; registra a presença', async () => {
    const { f, user } = await open(
      [
        registration(),
        registration({
          id: '44444444-4444-4444-8444-444444444444',
          user_id: '55555555-5555-4555-8555-555555555555',
          status: 'WAITLISTED',
        }),
      ],
      happening,
      { [CHECK_IN]: () => jsonResponse(200, attendance()) },
    );
    await screen.findByRole('heading', { name: 'Maria Silva' });
    expect(screen.getAllByRole('button', { name: 'Fazer check-in' })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Fazer check-in' }));
    expect(await screen.findByText(/Presença registrada em/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fazer check-in' })).not.toBeInTheDocument();
    expect(headersOf(callsTo(f, CHECK_IN)[0])['Authorization']).toBe('Bearer tok.en.value');
  });

  it('fora da janela de atividade não há botão de check-in', async () => {
    await open([registration()], activity());
    await screen.findByRole('heading', { name: 'Maria Silva' });
    expect(screen.queryByRole('button', { name: 'Fazer check-in' })).not.toBeInTheDocument();
  });

  it('erro do serviço no check-in aparece traduzido e permite tentar de novo', async () => {
    const { user } = await open([registration()], happening, {
      [CHECK_IN]: () => problem(409, 'OUTSIDE_CHECK_IN_WINDOW', 'x'),
    });
    await screen.findByRole('heading', { name: 'Maria Silva' });
    await user.click(screen.getByRole('button', { name: 'Fazer check-in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Fora da janela de check-in da atividade.',
    );
    expect(screen.getByRole('button', { name: 'Fazer check-in' })).toBeEnabled();
  });

  it('403 (não administra a atividade) mostra a mensagem de permissão', async () => {
    await open([], happening, { [PARTICIPANTS]: () => problem(403, 'FORBIDDEN', 'x') });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Você não tem permissão para esta operação.',
    );
  });

  it('sem inscrições mostra o estado vazio', async () => {
    await open([], happening);
    expect(await screen.findByText('Ainda não há inscrições nesta atividade.')).toBeInTheDocument();
    expect(within(document.body).queryByRole('button', { name: 'Fazer check-in' })).toBeNull();
  });
});
