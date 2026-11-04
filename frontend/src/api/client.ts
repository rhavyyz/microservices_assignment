import type { z } from 'zod';
import { ApiError, isAbortError, parseErrorResponse } from './errors';

export interface ApiClientOptions {
  /** URL pública do Gateway (config.apiBaseUrl). */
  baseUrl: string;
  /** Devolve o Access Token em memória, ou null. É o único lugar que lê o token. */
  getToken: () => string | null;
  /** Chamado quando uma requisição AUTENTICADA recebe 401 (sessão inválida/expirada). */
  onUnauthorized?: () => void;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface RequestOptions<T> {
  method?: 'GET' | 'POST' | 'PATCH';
  /** Caminho relativo ao Gateway, começando por "/". */
  path: string;
  query?: Record<string, string | number | undefined>;
  body?: unknown;
  /** Envia o Bearer Token. Sem token na memória, falha como 401 sem chamar a rede. */
  auth?: boolean;
  schema: z.ZodType<T>;
  signal?: AbortSignal | undefined;
}

/**
 * Cliente HTTP único da aplicação (fetch nativo). Centraliza URL base, cabeçalhos, token, timeout, validação da
 * resposta e tradução de erros: nenhum componente repete essa lógica. Não registra nada em console.
 */
export class ApiClient {
  private readonly opts: ApiClientOptions;

  constructor(opts: ApiClientOptions) {
    this.opts = opts;
  }

  async request<T>(o: RequestOptions<T>): Promise<T> {
    const { baseUrl, getToken, onUnauthorized } = this.opts;
    const doFetch = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (o.body !== undefined) headers['Content-Type'] = 'application/json';

    if (o.auth) {
      const token = getToken();
      if (!token) {
        onUnauthorized?.();
        throw new ApiError(401, 'UNAUTHENTICATED', 'Sessão ausente, inválida ou expirada.');
      }
      headers['Authorization'] = `Bearer ${token}`;
    }

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.opts.timeoutMs ?? 15000);
    const onExternalAbort = () => controller.abort();
    if (o.signal) {
      if (o.signal.aborted) controller.abort();
      else o.signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await doFetch(buildUrl(baseUrl, o.path, o.query), {
        method: o.method ?? 'GET',
        headers,
        body: o.body === undefined ? null : JSON.stringify(o.body),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
      });
    } catch (e) {
      if (timedOut) throw new ApiError(0, 'TIMEOUT', 'O servidor demorou demais para responder.');
      if (isAbortError(e)) throw e; // cancelado por quem chamou (ex.: componente desmontado)
      throw new ApiError(0, 'NETWORK_ERROR', 'Não foi possível conectar ao servidor.');
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onExternalAbort);
    }

    if (!response.ok) {
      const error = await parseErrorResponse(response);
      if (o.auth && response.status === 401) onUnauthorized?.();
      throw error;
    }

    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ApiError(response.status, 'INVALID_RESPONSE', 'Resposta inválida do servidor.');
    }
    const parsed = o.schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(response.status, 'INVALID_RESPONSE', 'Resposta inválida do servidor.');
    }
    return parsed.data;
  }
}

function buildUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  return `${baseUrl}${path}${qs ? `?${qs}` : ''}`;
}
