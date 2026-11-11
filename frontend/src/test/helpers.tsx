import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { vi, type Mock } from 'vitest';
import { AppProviders } from '../AppProviders';
import { AppRoutes } from '../routes';
import { createServices } from '../services/createServices';

export const GATEWAY = 'https://gateway.test';
export const USER_ID = '00ec3dc4-9986-4159-b37f-9cc1087b9203';

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': status >= 400 ? 'application/problem+json' : 'application/json',
      ...headers,
    },
  });
}

export function textResponse(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain' } });
}

export function problem(
  status: number,
  code: string,
  detail: string,
  extra: Record<string, unknown> = {},
): Response {
  return jsonResponse(status, {
    type: 'about:blank',
    title: 'Erro',
    status,
    detail,
    code,
    traceId: 'trace-abc-12345',
    ...extra,
  });
}

export const profile = (over: Record<string, unknown> = {}) => ({
  id: USER_ID,
  name: 'Maria Silva',
  email: 'maria@example.com',
  roles: ['PARTICIPANT'],
  organizerRequest: 'NONE',
  createdAt: '2026-11-03T23:25:45.175467Z',
  updatedAt: '2026-11-03T23:25:45.175467Z',
  ...over,
});

export const loginBody = (roles: string[] = ['PARTICIPANT']) => ({
  accessToken: 'tok.en.value',
  tokenType: 'Bearer',
  expiresIn: 1800,
  user: { id: USER_ID, name: 'Maria Silva', email: 'maria@example.com', roles },
});

export type Handler = (req: { url: URL; init: RequestInit }) => Response | Promise<Response>;

/** fetch falso baseado em rotas "MÉTODO /caminho". Rota não prevista falha o teste. */
/** WebSocket falso: nenhuma rede; os testes disparam quadros e fechamentos à mão. */
export class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset() {
    FakeWebSocket.instances = [];
  }
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  closed = false;
  constructor(public url: string) {
    FakeWebSocket.instances.push(this);
  }
  close() {
    this.closed = true;
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }
  drop(code = 1006) {
    this.onclose?.({ code } as CloseEvent);
  }
}

export function fakeFetch(routes: Record<string, Handler>): Mock<typeof fetch> {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = (init.method ?? 'GET').toUpperCase();
    const handler = routes[`${method} ${url.pathname}`];
    if (!handler) throw new Error(`Requisição não prevista no teste: ${method} ${url.pathname}`);
    return handler({ url, init });
  }) as Mock<typeof fetch>;
}

export type Route = string | { pathname: string; state?: unknown };

export function renderApp(fetchImpl: typeof fetch, route: Route = '/') {
  const services = createServices(
    { apiBaseUrl: GATEWAY },
    fetchImpl,
    FakeWebSocket as unknown as typeof WebSocket,
  );
  const user = userEvent.setup();
  const utils = render(
    <AppProviders services={services}>
      <MemoryRouter initialEntries={[route]}>
        <AppRoutes />
      </MemoryRouter>
    </AppProviders>,
  );
  return { user, services, ...utils };
}

export async function fillLogin(
  user: ReturnType<typeof userEvent.setup>,
  email = 'maria@example.com',
  pw = 'senha-forte-123',
) {
  await user.type(screen.getByLabelText('E-mail'), email);
  await user.type(screen.getByLabelText('Senha'), pw);
  await user.click(screen.getByRole('button', { name: 'Entrar' }));
}

export function headersOf(call: unknown[] | undefined): Record<string, string> {
  const init = (call?.[1] ?? {}) as RequestInit;
  return (init.headers ?? {}) as Record<string, string>;
}

/** Abre o login já apontando para `path`: depois de entrar, o app volta para lá (fluxo real de "voltar ao destino"). */
export async function signInTo(
  fetchImpl: typeof fetch,
  path: string,
  roles: string[] = ['PARTICIPANT'],
) {
  void roles;
  const ctx = renderApp(fetchImpl, { pathname: '/entrar', state: { from: path } });
  await fillLogin(ctx.user);
  return ctx;
}
