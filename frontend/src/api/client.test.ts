import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { jsonResponse, problem, textResponse } from '../test/helpers';
import { ApiClient } from './client';
import { ApiError, describeError } from './errors';

const schema = z.object({ ok: z.boolean() });
const BASE = 'https://gateway.test';

function client(
  fetchImpl: typeof fetch,
  over: { token?: string | null; onUnauthorized?: () => void; timeoutMs?: number } = {},
) {
  const token = over.token === undefined ? 'secret-token' : over.token;
  return new ApiClient({
    baseUrl: BASE,
    getToken: () => token,
    fetchImpl,
    ...(over.onUnauthorized ? { onUnauthorized: over.onUnauthorized } : {}),
    ...(over.timeoutMs ? { timeoutMs: over.timeoutMs } : {}),
  });
}

async function catchError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error('esperava um erro');
}

describe('ApiClient', () => {
  it('monta a URL a partir da URL pública configurada, sem parâmetros vazios', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
    await client(f).request({
      path: '/user/api/v1/users',
      query: { name: 'ana', email: '', id: undefined, page: 0 },
      schema,
    });
    expect(f.mock.calls[0]?.[0]).toBe(`${BASE}/user/api/v1/users?name=ana&page=0`);
  });

  it('envia Authorization somente em chamadas autenticadas e nunca na URL', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
    const c = client(f);
    await c.request({ path: '/a', schema });
    await c.request({ path: '/b', auth: true, schema });
    const [anon, authed] = f.mock.calls.map(
      (call) => (call[1]?.headers ?? {}) as Record<string, string>,
    );
    expect(anon?.['Authorization']).toBeUndefined();
    expect(authed?.['Authorization']).toBe('Bearer secret-token');
    expect(String(f.mock.calls[1]?.[0])).not.toContain('secret-token');
  });

  it('não usa cookies nem cache e envia JSON com Content-Type', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
    await client(f).request({ method: 'POST', path: '/x', body: { a: 1 }, schema });
    const init = f.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(init.body).toBe('{"a":1}');
  });

  it('sem token, uma chamada autenticada falha como 401 sem chamar a rede', async () => {
    const f = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: true }));
    const onUnauthorized = vi.fn();
    const err = await catchError(
      client(f, { token: null, onUnauthorized }).request({ path: '/me', auth: true, schema }),
    );
    expect(err.status).toBe(401);
    expect(f).not.toHaveBeenCalled();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('401 em chamada autenticada avisa a sessão; 401 de login (sem auth) não', async () => {
    const f = vi.fn<typeof fetch>(async () =>
      problem(401, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos.'),
    );
    const onUnauthorized = vi.fn();
    const c = client(f, { onUnauthorized });
    expect(
      (await catchError(c.request({ path: '/login', method: 'POST', body: {}, schema }))).code,
    ).toBe('INVALID_CREDENTIALS');
    expect(onUnauthorized).not.toHaveBeenCalled();
    await catchError(c.request({ path: '/me', auth: true, schema }));
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('traduz problem+json: código, mensagem, traceId e erros por campo', async () => {
    const f = vi.fn<typeof fetch>(async () =>
      problem(400, 'VALIDATION_ERROR', 'Verifique os campos enviados.', {
        errors: [{ field: 'email', message: 'Informe um e-mail válido.' }, { nada: true }],
      }),
    );
    const err = await catchError(client(f).request({ path: '/x', schema }));
    expect(err).toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      traceId: 'trace-abc-12345',
    });
    expect(err.fieldErrors).toEqual([{ field: 'email', message: 'Informe um e-mail válido.' }]);
  });

  it.each([
    [401, 'unauthorized', 'UNAUTHENTICATED'],
    [404, 'not found', 'NOT_FOUND'],
    [429, 'too many', 'RATE_LIMITED'],
    [503, 'unavailable', 'SERVICE_UNAVAILABLE'],
    [502, 'bad gateway', 'SERVER_ERROR'],
    [418, 'teapot', 'HTTP_ERROR'],
  ])('entende a resposta de texto puro do Gateway (%i)', async (status, body, code) => {
    const f = vi.fn<typeof fetch>(async () => textResponse(status, body));
    const err = await catchError(client(f).request({ path: '/x', schema }));
    expect(err.code).toBe(code);
    expect(err.message).not.toContain(body);
  });

  it('usa o primeiro valor do X-Trace-Id duplicado ("id, id"), e aceita o nome antigo X-Request-Id', async () => {
    const dup = vi.fn<typeof fetch>(
      async () => new Response('x', { status: 500, headers: { 'X-Trace-Id': 'abc123, abc123' } }),
    );
    expect((await catchError(client(dup).request({ path: '/x', schema }))).traceId).toBe('abc123');
    const legacy = vi.fn<typeof fetch>(
      async () => new Response('x', { status: 500, headers: { 'X-Request-Id': 'old-777' } }),
    );
    expect((await catchError(client(legacy).request({ path: '/x', schema }))).traceId).toBe(
      'old-777',
    );
  });

  it('falha de rede vira NETWORK_ERROR com texto amigável', async () => {
    const f = vi.fn<typeof fetch>(async () => {
      throw new TypeError('Failed to fetch');
    });
    const err = await catchError(client(f).request({ path: '/x', schema }));
    expect(err.code).toBe('NETWORK_ERROR');
    expect(describeError(err).message).toContain('Verifique sua conexão');
  });

  it('estoura o tempo limite como TIMEOUT', async () => {
    const f = vi.fn(
      (_: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_res, rej) =>
          init?.signal?.addEventListener('abort', () =>
            rej(new DOMException('abort', 'AbortError')),
          ),
        ),
    );
    const err = await catchError(
      client(f as typeof fetch, { timeoutMs: 20 }).request({ path: '/x', schema }),
    );
    expect(err.code).toBe('TIMEOUT');
  });

  it('propaga o cancelamento feito por quem chamou (componente desmontado)', async () => {
    const f = vi.fn(
      (_: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_res, rej) =>
          init?.signal?.addEventListener('abort', () =>
            rej(new DOMException('abort', 'AbortError')),
          ),
        ),
    );
    const ctrl = new AbortController();
    const p = client(f as typeof fetch).request({ path: '/x', schema, signal: ctrl.signal });
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('resposta fora do contrato ou não JSON vira INVALID_RESPONSE', async () => {
    const wrongShape = vi.fn<typeof fetch>(async () => jsonResponse(200, { ok: 'sim' }));
    expect((await catchError(client(wrongShape).request({ path: '/x', schema }))).code).toBe(
      'INVALID_RESPONSE',
    );
    const notJson = vi.fn<typeof fetch>(async () => textResponse(200, '<html>'));
    expect((await catchError(client(notJson).request({ path: '/x', schema }))).code).toBe(
      'INVALID_RESPONSE',
    );
  });

  it('erros internos não mostram detalhes técnicos, só o código de rastreio', () => {
    const d = describeError(
      new ApiError(500, 'INTERNAL_ERROR', 'java.lang.NullPointerException', 'trace-1'),
    );
    expect(d.message).not.toContain('java');
    expect(d.traceId).toBe('trace-1');
  });
});

describe('ApiClient.requestBlob', () => {
  const pdf = () =>
    new Response(new TextEncoder().encode('%PDF-1.4'), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf; charset=binary' },
    });

  it('envia Bearer e Accept do tipo pedido e devolve o Blob', async () => {
    const f = vi.fn<typeof fetch>(async () => pdf());
    const blob = await client(f).requestBlob({ path: '/c/1', auth: true }, 'application/pdf');
    expect(blob.size).toBeGreaterThan(0);
    const headers = (f.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer secret-token');
    expect(headers['Accept']).toBe('application/pdf');
    expect((f.mock.calls[0]![1] as RequestInit).method).toBe('GET');
  });

  it('tipo de conteúdo diferente do esperado vira INVALID_RESPONSE', async () => {
    const f = vi.fn<typeof fetch>(
      async () =>
        new Response('<html/>', { status: 200, headers: { 'Content-Type': 'text/html' } }),
    );
    const err = await catchError(
      client(f).requestBlob({ path: '/c/1', auth: true }, 'application/pdf'),
    );
    expect(err.code).toBe('INVALID_RESPONSE');
  });

  it('sem Content-Type também é recusado', async () => {
    const f = vi.fn<typeof fetch>(
      async () => new Response(new TextEncoder().encode('x'), { status: 200 }),
    );
    const err = await catchError(
      client(f).requestBlob({ path: '/c/1', auth: true }, 'application/pdf'),
    );
    expect(err.code).toBe('INVALID_RESPONSE');
  });

  it('erro HTTP usa o mesmo tratamento (problem+json traduzido) e 401 chama onUnauthorized', async () => {
    const onUnauthorized = vi.fn();
    const f = vi.fn<typeof fetch>(async () => problem(401, 'UNAUTHENTICATED', 'x'));
    const err = await catchError(
      client(f, { onUnauthorized }).requestBlob(
        { path: '/c/1', auth: true, localMessages: true },
        'application/pdf',
      ),
    );
    expect(err.status).toBe(401);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('sem token não chama a rede', async () => {
    const f = vi.fn<typeof fetch>();
    const err = await catchError(
      client(f, { token: null }).requestBlob({ path: '/c/1', auth: true }, 'application/pdf'),
    );
    expect(err.status).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });
});
