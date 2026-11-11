import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  EVENT_ID,
  activityReport,
  activityReportPage,
  notificationList,
  reportSummary,
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

const LOGIN = 'POST /user/api/v1/auth/login';
const SUMMARY = `GET /reports/events/${EVENT_ID}/summary`;
const ACTS = `GET /reports/events/${EVENT_ID}/activities`;
const PATH = `/organizador/eventos/${EVENT_ID}/relatorio`;
const base = (roles: string[] = ['ORGANIZER']) => ({
  [LOGIN]: () => jsonResponse(200, loginBody(roles)),
  'GET /notifications/list': () => jsonResponse(200, notificationList([])),
  [SUMMARY]: () => jsonResponse(200, reportSummary()),
  [ACTS]: () => jsonResponse(200, activityReportPage([activityReport()])),
});
const callsTo = (f: ReturnType<typeof fakeFetch>, key: string) =>
  f.mock.calls.filter((c) => {
    const u = new URL(String(c[0]));
    return (
      `${((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase()} ${u.pathname}` === key
    );
  });
const open = async (routes: Record<string, Handler> = {}, path = PATH, roles?: string[]) => {
  const f = fakeFetch({ ...base(roles), ...routes });
  return { f, ...(await signInTo(f, path)) };
};
const metric = (group: string, label: string) =>
  within(screen.getByLabelText(group)).getByText(label).parentElement!;

describe('Relatório do evento', () => {
  it('mostra inscrições, pagamentos, ocupação e presença, com Bearer', async () => {
    const { f } = await open();
    expect(
      await screen.findByRole('heading', { name: 'Relatório: Semana de Tecnologia' }),
    ).toBeInTheDocument();
    expect(headersOf(callsTo(f, SUMMARY)[0])['Authorization']).toBe('Bearer tok.en.value');

    expect(within(metric('Inscrições', 'Total')).getByText('28')).toBeInTheDocument();
    expect(within(metric('Inscrições', 'Confirmadas')).getByText('4')).toBeInTheDocument();
    expect(within(metric('Inscrições', 'Na lista de espera')).getByText('3')).toBeInTheDocument();
    expect(within(metric('Pagamentos', 'Aprovados')).getByText('2')).toBeInTheDocument();
    expect(within(metric('Pagamentos', 'Reembolsados')).getByText('1')).toBeInTheDocument();
    expect(within(metric('Ocupação', 'Vagas ocupadas')).getByText('7 de 20')).toBeInTheDocument();
    expect(within(metric('Ocupação', 'Taxa de ocupação')).getByText('35,0%')).toBeInTheDocument();
    expect(within(metric('Presença', 'Taxa de presença')).getByText('75,0%')).toBeInTheDocument();
    expect(within(metric('Presença', 'Aptos a certificado')).getByText('2')).toBeInTheDocument();
    expect(screen.getByText('1 aberta(s) · 2 encerrada(s) · 1 cancelada(s)')).toBeInTheDocument();
  });

  it('dinheiro por moeda, sem somar moedas diferentes', async () => {
    await open();
    await screen.findByRole('heading', { name: /Relatório:/ });
    const receita = metric('Pagamentos', 'Receita').textContent ?? '';
    expect(receita).toMatch(/R\$\s*25,00/);
    expect(receita).toMatch(/US\$\s*10,00/);
    expect(receita).not.toMatch(/35,00/);
    expect(metric('Pagamentos', 'Valor reembolsado').textContent).toMatch(/R\$\s*7,00/);
  });

  it('sem receita nem reembolso: mensagem clara; moeda desconhecida não quebra a tela', async () => {
    const s = reportSummary();
    await open({
      [SUMMARY]: () =>
        jsonResponse(200, {
          ...s,
          payments: {
            ...(s.payments as object),
            revenue: [{ currency: 'UNKNOWN', amount_minor: 1500 }],
            refunded: [],
          },
        }),
    });
    await screen.findByRole('heading', { name: /Relatório:/ });
    expect(metric('Pagamentos', 'Receita').textContent).toContain('UNKNOWN');
    expect(
      within(metric('Pagamentos', 'Valor reembolsado')).getByText('Nenhum reembolso'),
    ).toBeInTheDocument();
  });

  it('taxas nulas (denominador zero) aparecem como "—", não como 0%', async () => {
    const s = reportSummary();
    await open({
      [SUMMARY]: () =>
        jsonResponse(200, {
          ...s,
          occupancy: { capacity: 0, occupied: 0, rate: null },
          attendance: {
            confirmed: 0,
            checkins: 0,
            rate: null,
            certificate_eligible: 0,
            certificate_eligible_rate: null,
          },
        }),
    });
    await screen.findByRole('heading', { name: /Relatório:/ });
    expect(within(metric('Ocupação', 'Taxa de ocupação')).getByText('—')).toBeInTheDocument();
    expect(within(metric('Presença', 'Taxa de presença')).getByText('—')).toBeInTheDocument();
  });

  it('tabela por atividade com ocupação, receita e presença; cancelada sem taxa de ocupação', async () => {
    await open({
      [ACTS]: () =>
        jsonResponse(
          200,
          activityReportPage([
            activityReport(),
            activityReport({
              activity_id: '22222222-2222-4222-8222-222222222222',
              name: 'Palestra',
              lifecycle: 'CANCELLED',
              occupancy_rate: null,
              revenue: [],
              capacity: 10,
              occupied: 0,
            }),
          ]),
        ),
    });
    const table = await screen.findByRole('table');
    const row = within(table).getByRole('row', { name: /Oficina de React/ });
    expect(within(row).getByText(/5 de 30 \(16,7%\)/)).toBeInTheDocument();
    expect(row.textContent).toMatch(/R\$\s*200,00/);
    expect(within(row).getByText('75,0%')).toBeInTheDocument();
    const cancelled = within(table).getByRole('row', { name: /Palestra/ });
    expect(cancelled.textContent).toContain('(cancelada)');
    expect(cancelled.textContent).toContain('(—)');
  });

  it('paginação das atividades usa o total e pede o deslocamento certo', async () => {
    const { f, user } = await open({
      [ACTS]: ({ url }) =>
        jsonResponse(200, {
          ...activityReportPage([activityReport()], 25),
          offset: Number(url.searchParams.get('offset')),
        }),
    });
    await screen.findByRole('table');
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    await screen.findByText('Página 2');
    const last = callsTo(f, ACTS).at(-1)!;
    expect(new URL(String(last[0])).searchParams.get('offset')).toBe('20');
    expect(screen.getByRole('button', { name: 'Próxima' })).toBeDisabled();
  });

  it('sem atividades mostra o estado vazio', async () => {
    await open({ [ACTS]: () => jsonResponse(200, activityReportPage([])) });
    expect(await screen.findByText('Este evento ainda não tem atividades.')).toBeInTheDocument();
  });

  it('evento de outro organizador ou inexistente (404 EVENT_NOT_FOUND) mostra "não encontrada"', async () => {
    await open({ [SUMMARY]: () => problem(404, 'EVENT_NOT_FOUND', 'event not found') });
    expect(await screen.findByRole('heading', { name: /não encontrada/i })).toBeInTheDocument();
  });

  it('id inválido não chama a API de relatórios', async () => {
    const { f } = await open({}, '/organizador/eventos/abc/relatorio');
    expect(await screen.findByRole('heading', { name: /não encontrada/i })).toBeInTheDocument();
    expect(f.mock.calls.some((c) => String(c[0]).includes('/reports/'))).toBe(false);
  });

  it('Gateway fora do ar (503 em texto): erro e "Tentar novamente"', async () => {
    let n = 0;
    const { user } = await open({
      [SUMMARY]: () =>
        ++n === 1 ? textResponse(503, 'service unavailable') : jsonResponse(200, reportSummary()),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/indisponível/);
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(await screen.findByRole('heading', { name: /Relatório:/ })).toBeInTheDocument();
  });

  it('"Atualizar" busca os números de novo', async () => {
    const { f, user } = await open();
    await screen.findByRole('heading', { name: /Relatório:/ });
    await user.click(screen.getByRole('button', { name: 'Atualizar' }));
    await screen.findByRole('heading', { name: /Relatório:/ });
    expect(callsTo(f, SUMMARY).length).toBeGreaterThanOrEqual(2);
  });

  it('resposta fora do contrato vira erro, não tela quebrada', async () => {
    await open({ [SUMMARY]: () => jsonResponse(200, { event: {} }) });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('participante não acessa o relatório nem chama a API de relatórios', async () => {
    const { f } = await open({}, PATH, ['PARTICIPANT']);
    expect(await screen.findByRole('heading', { name: 'Acesso negado' })).toBeInTheDocument();
    expect(f.mock.calls.some((c) => String(c[0]).includes('/reports/'))).toBe(false);
  });
});
