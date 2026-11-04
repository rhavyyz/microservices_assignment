export interface FieldIssue {
  field: string;
  message: string;
}

/** Erro da API (corpo application/problem+json) ou erro de transporte já traduzido. Nunca carrega token ou senha. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly traceId: string | undefined;
  readonly fieldErrors: FieldIssue[];

  constructor(
    status: number,
    code: string,
    message: string,
    traceId?: string,
    fieldErrors: FieldIssue[] = [],
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.traceId = traceId;
    this.fieldErrors = fieldErrors;
  }
}

export function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === 'AbortError';
}

export function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError(0, 'UNKNOWN', 'Ocorreu um erro inesperado. Tente novamente.');
}

const GENERIC: Record<number, [string, string]> = {
  401: ['UNAUTHENTICATED', 'Sessão ausente, inválida ou expirada.'],
  403: ['ACCESS_DENIED', 'Você não tem permissão para esta operação.'],
  404: ['NOT_FOUND', 'O recurso solicitado não foi encontrado.'],
  429: [
    'RATE_LIMITED',
    'Muitas requisições em pouco tempo. Aguarde um instante e tente novamente.',
  ],
  503: [
    'SERVICE_UNAVAILABLE',
    'O serviço está temporariamente indisponível. Tente novamente em instantes.',
  ],
};

function firstHeaderValue(value: string | null): string | undefined {
  // O Gateway e o serviço podem repetir o cabeçalho (chega como "id, id"): vale o primeiro valor.
  return value?.split(',')[0]?.trim() || undefined;
}

/**
 * Converte uma resposta de erro em ApiError. Entende o formato problem+json dos serviços e também as respostas de
 * texto puro que o Gateway devolve sozinho (401, 404, 429, 503).
 */
export async function parseErrorResponse(response: Response): Promise<ApiError> {
  const headerTrace = firstHeaderValue(response.headers.get('X-Request-Id'));
  let body: unknown;
  try {
    body = JSON.parse(await response.text());
  } catch {
    body = undefined;
  }
  if (body && typeof body === 'object' && 'code' in body && typeof body.code === 'string') {
    const b = body as Record<string, unknown>;
    const detail = typeof b['detail'] === 'string' ? b['detail'] : undefined;
    const title = typeof b['title'] === 'string' ? b['title'] : undefined;
    const errors = Array.isArray(b['errors']) ? b['errors'] : [];
    const fieldErrors: FieldIssue[] = errors.flatMap((i: unknown) =>
      i &&
      typeof i === 'object' &&
      typeof (i as Record<string, unknown>)['field'] === 'string' &&
      typeof (i as Record<string, unknown>)['message'] === 'string'
        ? [{ field: (i as FieldIssue).field, message: (i as FieldIssue).message }]
        : [],
    );
    const traceId = typeof b['traceId'] === 'string' ? b['traceId'] : headerTrace;
    return new ApiError(
      response.status,
      body.code,
      detail ?? title ?? 'Erro na requisição.',
      traceId,
      fieldErrors,
    );
  }
  const known = GENERIC[response.status];
  if (known) return new ApiError(response.status, known[0], known[1], headerTrace);
  if (response.status >= 500) {
    return new ApiError(
      response.status,
      'SERVER_ERROR',
      'Erro no servidor. Tente novamente em instantes.',
      headerTrace,
    );
  }
  return new ApiError(
    response.status,
    'HTTP_ERROR',
    'Não foi possível concluir a requisição.',
    headerTrace,
  );
}

export interface ErrorDescription {
  message: string;
  traceId: string | undefined;
}

/** Texto seguro para exibir ao usuário. Erros internos mostram só o código de rastreio, nunca detalhes técnicos. */
export function describeError(e: unknown): ErrorDescription {
  const err = toApiError(e);
  switch (err.code) {
    case 'NETWORK_ERROR':
      return {
        message: 'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.',
        traceId: undefined,
      };
    case 'TIMEOUT':
      return {
        message: 'O servidor demorou demais para responder. Tente novamente.',
        traceId: undefined,
      };
    case 'INTERNAL_ERROR':
    case 'SERVER_ERROR':
    case 'INVALID_RESPONSE':
    case 'UNKNOWN':
      return {
        message: 'Ocorreu um erro inesperado. Tente novamente em instantes.',
        traceId: err.traceId,
      };
    default:
      return { message: err.message, traceId: err.traceId };
  }
}
