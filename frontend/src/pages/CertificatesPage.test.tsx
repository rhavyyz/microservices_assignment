import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CERTIFICATE_ID,
  EVENT_ID,
  certificate,
  eventDetail,
  notificationList,
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
const CERTS = 'GET /certificates/api/v1/certificates/me';
const PDF = `GET /certificates/api/v1/certificates/${CERTIFICATE_ID}`;
const EVENT = `GET /events/api/v1/events/${EVENT_ID}`;
const base = {
  [LOGIN]: () => jsonResponse(200, loginBody(['PARTICIPANT'])),
  'GET /notifications/list': () => jsonResponse(200, notificationList([])),
  [CERTS]: () => jsonResponse(200, { certificates: [certificate()] }),
  [EVENT]: () => jsonResponse(200, eventDetail()),
};
const pdfResponse = () =>
  new Response(new TextEncoder().encode('%PDF-1.4 teste'), {
    status: 200,
    headers: { 'Content-Type': 'application/pdf' },
  });
const callsTo = (f: ReturnType<typeof fakeFetch>, key: string) =>
  f.mock.calls.filter((c) => {
    const u = new URL(String(c[0]));
    return (
      `${((c[1] as RequestInit | undefined)?.method ?? 'GET').toUpperCase()} ${u.pathname}` === key
    );
  });
const open = async (routes: Record<string, Handler> = {}) => {
  const f = fakeFetch({ ...base, ...routes });
  return { f, ...(await signInTo(f, '/certificados')) };
};

let saved: { href: string; download: string }[] = [];
let created: Blob[] = [];
let revoked: string[] = [];
beforeEach(() => {
  saved = [];
  created = [];
  revoked = [];
  URL.createObjectURL = vi.fn((b: Blob) => {
    created.push(b);
    return `blob:teste/${created.length}`;
  });
  URL.revokeObjectURL = vi.fn((u: string) => {
    revoked.push(u);
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ href: this.href, download: this.download });
  });
});
afterEach(() => vi.restoreAllMocks());

describe('Meus certificados', () => {
  it('lista com o nome do evento (de Eventos, sem token), data de emissão e link do evento', async () => {
    const { f } = await open();
    expect(
      await screen.findByRole('heading', { name: 'Semana de Tecnologia' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/Emitido em/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Ver evento' })).toHaveAttribute(
      'href',
      `/eventos/${EVENT_ID}`,
    );
    expect(headersOf(callsTo(f, CERTS)[0])['Authorization']).toBe('Bearer tok.en.value');
    expect(headersOf(callsTo(f, EVENT)[0])['Authorization']).toBeUndefined();
  });

  it('se o nome do evento não carregar, mostra o certificado mesmo assim', async () => {
    await open({ [EVENT]: () => problem(404, 'NOT_FOUND', 'x') });
    expect(
      await screen.findByRole('heading', { name: 'Certificado de participação' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Baixar PDF' })).toBeInTheDocument();
  });

  it('certificado antigo sem event_id: não consulta Eventos e não mostra link', async () => {
    const { f } = await open({
      [CERTS]: () => jsonResponse(200, { certificates: [certificate({ event_id: null })] }),
    });
    expect(
      await screen.findByRole('heading', { name: 'Certificado de participação' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Ver evento' })).not.toBeInTheDocument();
    expect(callsTo(f, EVENT)).toHaveLength(0);
  });

  it('vazio explica quando o certificado é emitido (evento encerrado e 75% de presença)', async () => {
    await open({ [CERTS]: () => jsonResponse(200, { certificates: [] }) });
    expect(await screen.findByText(/Você ainda não tem certificados/)).toBeInTheDocument();
    expect(screen.getByText(/pelo menos 75%/)).toBeInTheDocument();
  });

  it('baixar: busca o PDF COM Bearer e entrega o arquivo certificado-<id>.pdf; libera o endereço temporário', async () => {
    const { f, user } = await open({ [PDF]: pdfResponse });
    await user.click(await screen.findByRole('button', { name: 'Baixar PDF' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toMatchObject({ download: `certificado-${CERTIFICATE_ID}.pdf` });
    expect(saved[0]!.href).toMatch(/^blob:/);
    expect(created[0]!.type).toBe('application/pdf');
    expect(headersOf(callsTo(f, PDF)[0])['Authorization']).toBe('Bearer tok.en.value');
    expect(headersOf(callsTo(f, PDF)[0])['Accept']).toBe('application/pdf');
    await waitFor(() => expect(revoked).toHaveLength(1));
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('404 (certificado de outra pessoa ou inexistente) mostra mensagem e não baixa nada', async () => {
    const { user } = await open({ [PDF]: () => problem(404, 'NOT_FOUND', 'x') });
    await user.click(await screen.findByRole('button', { name: 'Baixar PDF' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'O recurso solicitado não foi encontrado.',
    );
    expect(saved).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Baixar PDF' })).toBeEnabled();
  });

  it('503 (arquivo indisponível) mostra erro e permite tentar de novo', async () => {
    let n = 0;
    const { user } = await open({
      [PDF]: () => (++n === 1 ? problem(503, 'SERVICE_UNAVAILABLE', 'x') : pdfResponse()),
    });
    await user.click(await screen.findByRole('button', { name: 'Baixar PDF' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Baixar PDF' }));
    await waitFor(() => expect(saved).toHaveLength(1));
  });

  it('resposta que não é PDF (ex.: HTML de um proxy) é recusada, não entregue como arquivo', async () => {
    const { user } = await open({
      [PDF]: () =>
        new Response('<html>erro</html>', {
          status: 200,
          headers: { 'Content-Type': 'text/html' },
        }),
    });
    await user.click(await screen.findByRole('button', { name: 'Baixar PDF' }));
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(saved).toHaveLength(0);
  });

  it('falha ao listar (texto puro 503) mostra erro e tentar de novo funciona', async () => {
    let n = 0;
    const { user } = await open({
      [CERTS]: () =>
        ++n === 1
          ? textResponse(503, 'service unavailable')
          : jsonResponse(200, { certificates: [certificate()] }),
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/indisponível/);
    await user.click(screen.getByRole('button', { name: 'Tentar novamente' }));
    expect(
      await screen.findByRole('heading', { name: 'Semana de Tecnologia' }),
    ).toBeInTheDocument();
  });

  it('paginação: "Próxima" só quando a página veio cheia (50) e pede offset 50', async () => {
    const many = Array.from({ length: 50 }, (_, i) =>
      certificate({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`, event_id: null }),
    );
    const { f, user } = await open({
      [CERTS]: ({ url }) =>
        jsonResponse(200, { certificates: url.searchParams.get('offset') === '50' ? [] : many }),
    });
    await screen.findAllByRole('button', { name: 'Baixar PDF' });
    await user.click(screen.getByRole('button', { name: 'Próxima' }));
    expect(await screen.findByText('Não há mais certificados.')).toBeInTheDocument();
    expect(new URL(String(callsTo(f, CERTS).at(-1)![0])).searchParams.get('offset')).toBe('50');
  });
});
