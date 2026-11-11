import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EVENT_ID,
  PAYMENT_ID,
  REGISTRATION_ID,
  ACTIVITY_ID,
  activity,
  notificationList,
  payment,
  registration,
} from '../test/fixtures';
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
import { paymentPolling } from '../components/payment';

const LOGIN = 'POST /user/api/v1/auth/login';
const PAY = '/payments/payments';
const GET_PAYMENT = `GET ${PAY}/${PAYMENT_ID}`;
const SIMULATE = `POST ${PAY}/${PAYMENT_ID}/simulate`;
const NOTIFS = 'GET /notifications/list';
const base = {
  [LOGIN]: () => jsonResponse(200, loginBody(['PARTICIPANT'])),
  [NOTIFS]: () => jsonResponse(200, notificationList([])),
};
const callsTo = (f: ReturnType<typeof fakeFetch>, key: string) =>
  f.mock.calls.filter((c) => {
    const u = new URL(String(c[0]));
    return (
      `${((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase()} ${u.pathname}` === key
    );
  });

const open = (routes: Record<string, Handler>, path = `/pagamentos/${PAYMENT_ID}`) => {
  const f = fakeFetch({ ...base, ...routes });
  return signInTo(f, path).then((ctx) => ({ f, ...ctx }));
};

const originalInterval = paymentPolling.intervalMs;
afterEach(() => {
  paymentPolling.intervalMs = originalInterval;
});

describe('Pagamento', () => {
  it('mostra valor, situação, prazo e as ações do provedor simulado, com Bearer', async () => {
    const { f } = await open({ [GET_PAYMENT]: () => jsonResponse(200, payment()) });
    expect(await screen.findByRole('heading', { name: 'Pagamento' })).toBeInTheDocument();
    expect(screen.getByText('Aguardando pagamento')).toBeInTheDocument();
    expect(screen.getByText(/R\$\s*50,00/)).toBeInTheDocument();
    expect(screen.getByText(/Prazo:/)).toBeInTheDocument();
    expect(screen.getByText(/nenhuma cobrança real é feita/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Aprovar pagamento' })).toBeInTheDocument();
    expect(headersOf(callsTo(f, GET_PAYMENT)[0])['Authorization']).toBe('Bearer tok.en.value');
  });

  it('aprovar: envia {action:"approve"}, mostra aprovado e esconde o simulador', async () => {
    const { f, user } = await open({
      [GET_PAYMENT]: () => jsonResponse(200, payment()),
      [SIMULATE]: () => jsonResponse(200, payment({ status: 'APPROVED' })),
    });
    await user.click(await screen.findByRole('button', { name: 'Aprovar pagamento' }));
    expect(await screen.findByText('Pagamento aprovado')).toBeInTheDocument();
    expect(
      screen.getByText(/confirmação da inscrição pode levar alguns instantes/),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Aprovar pagamento' })).not.toBeInTheDocument();
    expect(JSON.parse(String((callsTo(f, SIMULATE)[0]![1] as RequestInit).body))).toEqual({
      action: 'approve',
    });
    expect(
      within(screen.getByRole('main')).getByRole('link', { name: 'Minhas inscrições' }),
    ).toHaveAttribute('href', '/inscricoes');
  });

  it.each([
    [
      'decline',
      'Recusar pagamento',
      'DECLINED',
      'Pagamento recusado',
      /vaga reservada foi liberada/,
    ],
    [
      'expire',
      'Deixar o prazo expirar',
      'EXPIRED',
      'Prazo expirado',
      /vaga reservada foi liberada/,
    ],
  ])('%s: mostra o estado final e a vaga liberada', async (action, label, status, text, hint) => {
    const { f, user } = await open({
      [GET_PAYMENT]: () => jsonResponse(200, payment()),
      [SIMULATE]: () => jsonResponse(200, payment({ status })),
    });
    await user.click(await screen.findByRole('button', { name: label }));
    expect((await screen.findAllByText(text)).length).toBeGreaterThan(0);
    expect(screen.getByText(hint)).toBeInTheDocument();
    expect(JSON.parse(String((callsTo(f, SIMULATE)[0]![1] as RequestInit).body))).toEqual({
      action,
    });
    expect(screen.getByRole('link', { name: 'Ver evento' })).toHaveAttribute(
      'href',
      `/eventos/${EVENT_ID}`,
    );
  });

  it('409 PAYMENT_NOT_APPLIED: explica e recarrega o estado real (já aprovado)', async () => {
    let status = 'PENDING';
    const { user } = await open({
      [GET_PAYMENT]: () => jsonResponse(200, payment({ status })),
      [SIMULATE]: () => {
        status = 'APPROVED';
        return problem(409, 'PAYMENT_NOT_APPLIED', 'already final');
      },
    });
    await user.click(await screen.findByRole('button', { name: 'Recusar pagamento' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('A ação não foi aplicada');
    expect(await screen.findByText('Pagamento aprovado')).toBeInTheDocument();
  });

  it('simulador desligado (404 NOT_FOUND) mostra mensagem em português', async () => {
    const { user } = await open({
      [GET_PAYMENT]: () => jsonResponse(200, payment()),
      [SIMULATE]: () => problem(404, 'NOT_FOUND', 'not found'),
    });
    await user.click(await screen.findByRole('button', { name: 'Aprovar pagamento' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'O recurso solicitado não foi encontrado.',
    );
  });

  it('enquanto pendente consulta de novo e passa a aprovado sozinho; depois para de consultar', async () => {
    paymentPolling.intervalMs = 30;
    let status = 'PENDING';
    const { f } = await open({ [GET_PAYMENT]: () => jsonResponse(200, payment({ status })) });
    await screen.findByText('Aguardando pagamento');
    status = 'APPROVED';
    expect(await screen.findByText('Pagamento aprovado')).toBeInTheDocument();
    const n = callsTo(f, GET_PAYMENT).length;
    await new Promise((r) => setTimeout(r, 200));
    expect(callsTo(f, GET_PAYMENT)).toHaveLength(n);
  });

  it('pagamento de outra pessoa/inexistente (404) mostra "não encontrada"; id inválido nem chama a API', async () => {
    await open({ [GET_PAYMENT]: () => problem(404, 'PAYMENT_NOT_FOUND', 'x') });
    expect(await screen.findByRole('heading', { name: /não encontrada/i })).toBeInTheDocument();
  });

  it('id inválido não chama a API de pagamentos', async () => {
    const { f } = await open({}, '/pagamentos/abc');
    expect(await screen.findByRole('heading', { name: /não encontrada/i })).toBeInTheDocument();
    expect(f.mock.calls.some((c) => String(c[0]).includes('/payments/'))).toBe(false);
  });

  it('Gateway fora do ar (503 em texto) mostra erro e permite tentar de novo', async () => {
    let n = 0;
    const { user } = await open({
      [GET_PAYMENT]: () =>
        ++n === 1 ? textResponse(503, 'service unavailable') : jsonResponse(200, payment()),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/indisponível/);
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByText('Aguardando pagamento')).toBeInTheDocument();
  });

  it('resposta fora do contrato vira erro, não tela quebrada', async () => {
    await open({ [GET_PAYMENT]: () => jsonResponse(200, { payment_id: PAYMENT_ID }) });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });
});

describe('Minhas inscrições: Pagar', () => {
  const MINE = 'GET /subscription/api/v1/registrations/me';
  const ACT = `GET /events/api/v1/activities/${ACTIVITY_ID}`;
  const pending = registration({
    status: 'PENDING_PAYMENT',
    expires_at: '2099-03-10 12:15:00+00:00',
  });

  it('"Pagar" cria o pagamento só com registration_id e abre a tela do pagamento', async () => {
    const { f, user } = await open(
      {
        [MINE]: () => jsonResponse(200, { registrations: [pending] }),
        [ACT]: () => jsonResponse(200, activity()),
        [`POST ${PAY}`]: () => jsonResponse(201, payment()),
        [GET_PAYMENT]: () => jsonResponse(200, payment()),
      },
      '/inscricoes',
    );
    await user.click(await screen.findByRole('button', { name: 'Pagar' }));
    expect(await screen.findByRole('heading', { name: 'Pagamento' })).toBeInTheDocument();
    expect(JSON.parse(String((callsTo(f, `POST ${PAY}`)[0]![1] as RequestInit).body))).toEqual({
      registration_id: REGISTRATION_ID,
    });
  });

  it('só inscrição aguardando pagamento tem "Pagar"', async () => {
    await open(
      {
        [MINE]: () => jsonResponse(200, { registrations: [registration()] }),
        [ACT]: () => jsonResponse(200, activity()),
      },
      '/inscricoes',
    );
    await screen.findByRole('heading', { name: 'Oficina de React' });
    expect(screen.queryByRole('button', { name: 'Pagar' })).not.toBeInTheDocument();
  });

  it('REGISTRATION_NOT_PAYABLE aparece traduzido e o botão volta a ficar disponível', async () => {
    const { user } = await open(
      {
        [MINE]: () => jsonResponse(200, { registrations: [pending] }),
        [ACT]: () => jsonResponse(200, activity()),
        [`POST ${PAY}`]: () => problem(409, 'REGISTRATION_NOT_PAYABLE', 'x'),
      },
      '/inscricoes',
    );
    await user.click(await screen.findByRole('button', { name: 'Pagar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('não pode mais ser paga');
    expect(screen.getByRole('button', { name: 'Pagar' })).toBeEnabled();
  });
});
