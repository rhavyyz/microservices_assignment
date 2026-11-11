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

/**
 * Mensagens em português por código de erro. Os serviços de Eventos e de Inscrições respondem em inglês ou só com o
 * código (`title` = `code`, sem `detail`), então a interface traduz pelo código. Mensagens técnicas do servidor
 * nunca são mostradas nessas APIs.
 */
export const CODE_MESSAGES: Record<string, string> = {
  VALIDATION_ERROR: 'Verifique os dados informados.',
  BAD_REQUEST: 'A requisição é inválida.',
  UNAUTHENTICATED: 'Sua sessão expirou ou é inválida. Entre novamente.',
  FORBIDDEN: 'Você não tem permissão para esta operação.',
  ACCESS_DENIED: 'Você não tem permissão para esta operação.',
  NOT_FOUND: 'O recurso solicitado não foi encontrado.',
  RESOURCE_NOT_FOUND: 'O recurso solicitado não foi encontrado.',
  ACTIVITY_NOT_FOUND: 'A atividade não foi encontrada.',
  REGISTRATION_NOT_FOUND: 'A inscrição não foi encontrada.',
  INVALID_STATUS: 'Esta operação não é permitida no estado atual.',
  EVENT_CANCELLED: 'O evento foi cancelado.',
  EVENT_NOT_DRAFT: 'Isto só pode ser alterado enquanto o evento é um rascunho.',
  EVENT_WITHOUT_ACTIVITIES: 'Adicione ao menos uma atividade antes de publicar.',
  EVENT_ENDED: 'O evento já terminou.',
  EVENT_NOT_OPEN: 'O evento não está aberto para inscrições.',
  INVALID_PERIOD: 'O período informado é inválido.',
  ACTIVITY_OUTSIDE_EVENT: 'A atividade deve ficar dentro do período do evento.',
  ACTIVITY_ENDED: 'A atividade já terminou.',
  ACTIVITY_FULL: 'A atividade está lotada.',
  ACTIVITY_NOT_ENDED: 'A atividade ainda não terminou.',
  REGISTRATION_CLOSED: 'As inscrições para esta atividade estão encerradas.',
  CHECK_IN_NOT_ALLOWED: 'O check-in não é permitido para esta inscrição.',
  OUTSIDE_CHECK_IN_WINDOW: 'Fora da janela de check-in da atividade.',
  EVENT_NOT_FOUND: 'Evento não encontrado.',
  PAYMENT_NOT_FOUND: 'O pagamento não foi encontrado.',
  REGISTRATION_NOT_PAYABLE:
    'Esta inscrição não pode mais ser paga (o prazo terminou ou ela não está aguardando pagamento).',
  PAYMENT_NOT_APPLIED: 'A ação não foi aplicada: o pagamento já foi concluído ou o prazo terminou.',
  UPSTREAM_UNAVAILABLE:
    'Um serviço necessário está indisponível no momento. Tente novamente em instantes.',
  INVALID_PAYMENT_TRANSITION: 'Esta mudança de pagamento não é permitida agora.',
  PAYMENT_CONTRACT_MISMATCH: 'Os dados do pagamento não conferem.',
  IMMUTABLE_CAPACITY_MISMATCH: 'A capacidade da atividade não pode ser alterada.',
  DEPENDENCY_UNAVAILABLE:
    'Um serviço necessário está indisponível no momento. Tente novamente em instantes.',
  INVALID_EVENTS_CONTRACT:
    'Um serviço necessário está indisponível no momento. Tente novamente em instantes.',
  AUTH_UNAVAILABLE: 'Não foi possível validar sua sessão agora. Tente novamente em instantes.',
};

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

function fallbackMessage(status: number): string {
  return (
    GENERIC[status]?.[1] ??
    (status >= 500
      ? 'Erro no servidor. Tente novamente em instantes.'
      : 'Não foi possível concluir a operação.')
  );
}

function firstHeaderValue(value: string | null): string | undefined {
  // O Gateway e o serviço podem repetir o cabeçalho (chega como "id, id"): vale o primeiro valor.
  return value?.split(',')[0]?.trim() || undefined;
}

/**
 * Converte uma resposta de erro em ApiError. Entende o formato problem+json dos serviços e também as respostas de
 * texto puro que o Gateway devolve sozinho (401, 404, 429, 503).
 */
export async function parseErrorResponse(
  response: Response,
  localMessages = false,
): Promise<ApiError> {
  // O Gateway usa X-Trace-Id; X-Request-Id era o nome anterior e fica só como compatibilidade.
  const headerTrace = firstHeaderValue(
    response.headers.get('X-Trace-Id') ?? response.headers.get('X-Request-Id'),
  );
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
        ? [
            {
              field: (i as FieldIssue).field,
              // Mensagens de campo de serviços que respondem em inglês não são exibidas.
              message: localMessages ? 'Valor inválido.' : (i as FieldIssue).message,
            },
          ]
        : [],
    );
    const traceId = typeof b['traceId'] === 'string' ? b['traceId'] : headerTrace;
    const message = localMessages
      ? (CODE_MESSAGES[body.code] ?? fallbackMessage(response.status))
      : (detail ?? title ?? 'Erro na requisição.');
    return new ApiError(response.status, body.code, message, traceId, fieldErrors);
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
