import { act, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NOTIFICATION_ID, PAYMENT_ID, notification, notificationList } from '../test/fixtures';
import {
  FakeWebSocket,
  fakeFetch,
  headersOf,
  jsonResponse,
  loginBody,
  signInTo,
  textResponse,
  type Handler,
} from '../test/helpers';
import { CLOSE_REPLACED, RECONNECT_DELAYS_MS, socketUrl } from '../api/notificationsSocket';

const LOGIN = 'POST /user/api/v1/auth/login';
const LIST = 'GET /notifications/list';
const UPDATE = 'PUT /notifications/update-state';
const ID2 = '88888888-8888-4888-8888-888888888888';
const ID3 = '99999999-9999-4999-8999-999999999999';

beforeEach(() => FakeWebSocket.reset());
afterEach(() => FakeWebSocket.reset());

const login = { [LOGIN]: () => jsonResponse(200, loginBody(['PARTICIPANT'])) };
const callsTo = (f: ReturnType<typeof fakeFetch>, key: string) =>
  f.mock.calls.filter((c) => {
    const u = new URL(String(c[0]));
    return (
      `${((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase()} ${u.pathname}` === key
    );
  });
const paramsOf = (call: unknown[] | undefined) => new URL(String(call?.[0])).searchParams;
const open = async (routes: Record<string, Handler>, path = '/notificacoes') => {
  const f = fakeFetch({ ...login, ...routes });
  return { f, ...(await signInTo(f, path)) };
};

describe('Notificações', () => {
  it('lista as mensagens com Nova/Lida, data e o link certo por tipo, com Bearer', async () => {
    const items = [
      notification(),
      notification({
        id: ID2,
        status: 'SEEN',
        message: 'Sua inscrição foi confirmada.',
        payload_type: 'RegistrationConfirmed',
        payload: { registration_id: ID3 },
      }),
      notification({ id: ID3, message: 'Aviso sem destino', payload: null, payload_type: null }),
    ];
    const { f } = await open({ [LIST]: () => jsonResponse(200, notificationList(items)) });
    expect(await screen.findByText('Seu pagamento de BRL 50.00 foi aprovado.')).toBeInTheDocument();
    const links = screen.getAllByRole('link', { name: 'Ver detalhes' });
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      `/pagamentos/${PAYMENT_ID}`,
      '/inscricoes',
    ]);
    expect(screen.getAllByText('Nova').length).toBeGreaterThan(0);
    expect(screen.getByText('Lida')).toBeInTheDocument();
    expect(headersOf(callsTo(f, LIST).at(-1))['Authorization']).toBe('Bearer tok.en.value');
  });

  it('não vira link o redirect_url nem um payment_id que não é UUID', async () => {
    await open({
      [LIST]: () =>
        jsonResponse(
          200,
          notificationList([
            notification({
              redirect_url: 'https://evil.example/x',
              payload: { payment_id: '../x' },
            }),
          ]),
        ),
    });
    await screen.findByText('Seu pagamento de BRL 50.00 foi aprovado.');
    expect(screen.queryByRole('link', { name: 'Ver detalhes' })).not.toBeInTheDocument();
    expect(document.querySelector('a[href*="evil"]')).toBeNull();
  });

  it('estado vazio, e filtro "Não lidas" pede status DEFAULT,RECEIVED', async () => {
    const { f, user } = await open({ [LIST]: () => jsonResponse(200, notificationList([])) });
    expect(await screen.findByText('Você ainda não tem notificações.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Não lidas' }));
    expect(await screen.findByText('Você não tem notificações novas.')).toBeInTheDocument();
    const withStatus = callsTo(f, LIST).filter(
      (c) => paramsOf(c).has('status') && paramsOf(c).get('limit') === '20',
    );
    expect(paramsOf(withStatus.at(-1)).get('status')).toBe('DEFAULT,RECEIVED');
  });

  it('"Carregar mais" usa o cursor next_base_notification_id e acrescenta', async () => {
    const { f, user } = await open({
      [LIST]: ({ url }) =>
        url.searchParams.get('base_notification_id')
          ? jsonResponse(200, notificationList([notification({ id: ID2, message: 'Antiga' })]))
          : jsonResponse(200, notificationList([notification()], NOTIFICATION_ID)),
    });
    await screen.findByText('Seu pagamento de BRL 50.00 foi aprovado.');
    await user.click(screen.getByRole('button', { name: 'Carregar mais' }));
    expect(await screen.findByText('Antiga')).toBeInTheDocument();
    expect(screen.getByText('Seu pagamento de BRL 50.00 foi aprovado.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Carregar mais' })).not.toBeInTheDocument();
    expect(
      callsTo(f, LIST).some((c) => paramsOf(c).get('base_notification_id') === NOTIFICATION_ID),
    ).toBe(true);
  });

  it('marcar uma como lida: PUT [{id,status:SEEN}] e passa a "Lida"', async () => {
    const { f, user } = await open({
      [LIST]: () => jsonResponse(200, notificationList([notification()])),
      [UPDATE]: () => jsonResponse(200, { updated: 1, errors: {} }),
    });
    await user.click(await screen.findByRole('button', { name: 'Marcar como lida' }));
    await waitFor(() => expect(screen.getByText('Lida')).toBeInTheDocument());
    expect(JSON.parse(String((callsTo(f, UPDATE)[0]![1] as RequestInit).body))).toEqual([
      { id: NOTIFICATION_ID, status: 'SEEN' },
    ]);
    expect(screen.queryByRole('button', { name: 'Marcar como lida' })).not.toBeInTheDocument();
  });

  it('"Marcar todas como lidas" só envia as não lidas; erro parcial é informado e não marca a que falhou', async () => {
    const { f, user } = await open({
      [LIST]: () =>
        jsonResponse(
          200,
          notificationList([
            notification(),
            notification({ id: ID2, message: 'Outra' }),
            notification({ id: ID3, message: 'Já lida', status: 'SEEN' }),
          ]),
        ),
      [UPDATE]: () =>
        jsonResponse(200, { updated: 1, errors: { [ID2]: 'notification not found' } }),
    });
    await user.click(await screen.findByRole('button', { name: 'Marcar todas como lidas' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '1 notificação(ões) não puderam ser atualizadas',
    );
    const sent = JSON.parse(String((callsTo(f, UPDATE)[0]![1] as RequestInit).body)) as {
      id: string;
    }[];
    expect(sent.map((s) => s.id)).toEqual([NOTIFICATION_ID, ID2]);
    const outra = screen.getByText('Outra').closest('li')!;
    expect(within(outra).getByText('Nova')).toBeInTheDocument();
  });

  it('erro de lista (texto puro 500) mostra mensagem e permite tentar de novo', async () => {
    let n = 0;
    const { user } = await open({
      [LIST]: ({ url }) =>
        url.searchParams.get('limit') === '20' && ++n === 1
          ? textResponse(500, 'internal error')
          : jsonResponse(200, notificationList([notification()])),
    });
    expect(await screen.findByText(/erro inesperado/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Seu pagamento de BRL 50.00 foi aprovado.')).toBeInTheDocument();
  });
});

describe('Tempo real (WebSocket do Gateway)', () => {
  const listRoutes = { [LIST]: () => jsonResponse(200, notificationList([])) };

  it('conecta em wss://…/ws com o token na query e só depois do login', async () => {
    const f = fakeFetch({ ...login, ...listRoutes });
    expect(FakeWebSocket.instances).toHaveLength(0);
    await signInTo(f, '/inicio');
    await screen.findByRole('heading', { name: 'Início' });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const url = new URL(FakeWebSocket.instances[0]!.url);
    expect(url.protocol).toBe('wss:');
    expect(url.pathname).toBe('/ws');
    expect(url.searchParams.get('access_token')).toBe('tok.en.value');
  });

  it('socketUrl: http vira ws, https vira wss', () => {
    expect(socketUrl('http://localhost:8080', 't')).toBe('ws://localhost:8080/ws?access_token=t');
    expect(socketUrl('https://gw.test', 'a b')).toBe('wss://gw.test/ws?access_token=a+b');
  });

  it('notificação recebida entra no topo da lista aberta, sem duplicar, e aumenta o contador do menu', async () => {
    const { user } = await open({
      [LIST]: ({ url }) =>
        jsonResponse(
          200,
          notificationList(
            url.searchParams.get('limit') === '100'
              ? []
              : [notification({ id: ID2, message: 'Antiga', status: 'SEEN' })],
          ),
        ),
    });
    await screen.findByText('Antiga');
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.receive({ type: 'connected' }));
    act(() =>
      ws.receive({
        type: 'notification',
        notification: notification({ message: 'Nova por push' }),
      }),
    );
    expect(await screen.findByText('Nova por push')).toBeInTheDocument();
    act(() =>
      ws.receive({
        type: 'notification',
        notification: notification({ message: 'Nova por push' }),
      }),
    );
    expect(screen.getAllByText('Nova por push')).toHaveLength(1);
    const nav = screen.getByRole('navigation', { name: 'Navegação principal' });
    expect(within(nav).getByLabelText('1 não lidas')).toBeInTheDocument();
    void user;
  });

  it('quadros inválidos ou desconhecidos são ignorados sem quebrar', async () => {
    await open(listRoutes);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => {
      ws.onmessage?.({ data: 'não é json' } as MessageEvent);
      ws.receive({ type: 'algo-novo' });
      ws.receive({ type: 'notification', notification: { id: 'x' } });
    });
    expect(await screen.findByText('Você ainda não tem notificações.')).toBeInTheDocument();
  });

  it('se a conexão cair, reconecta com espera crescente; fechamento 4000 (outra aba) NÃO reconecta', async () => {
    await open(listRoutes);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0]!.drop(1006));
    expect(FakeWebSocket.instances).toHaveLength(1); // ainda esperando o intervalo
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2), {
      timeout: RECONNECT_DELAYS_MS[0] + 1500,
    });
    act(() => FakeWebSocket.instances[1]!.drop(CLOSE_REPLACED));
    await new Promise((r) => setTimeout(r, RECONNECT_DELAYS_MS[0] + 1200));
    expect(FakeWebSocket.instances).toHaveLength(2);
  }, 15000);

  it('sair da conta fecha a conexão', async () => {
    const { user } = await open(listRoutes);
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await user.click(screen.getByRole('button', { name: 'Sair' }));
    await screen.findByRole('heading', { name: 'Entrar' });
    expect(FakeWebSocket.instances[0]!.closed).toBe(true);
  });
});
