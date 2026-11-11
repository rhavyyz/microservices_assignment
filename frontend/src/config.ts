/**
 * Configuração central do frontend. O único endereço de backend conhecido é o do API Gateway, vindo de
 * VITE_API_BASE_URL (valor público após o build). Os caminhos das APIs também ficam aqui, num lugar só.
 */

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface AppConfig {
  /** URL pública do Gateway, sem barra final. */
  apiBaseUrl: string;
}

/**
 * Caminhos das APIs, relativos ao Gateway. O Gateway roteia por `/{serviço}/...` e remove o prefixo antes de
 * chamar o serviço. Os demais serviços entram aqui quando seus contratos forem confirmados (docs/integration).
 */
export const API_PATHS = {
  users: '/user/api/v1',
  events: '/events/api/v1',
  subscription: '/subscription/api/v1',
  /** Kind `payments` + rotas `/payments/...` do próprio serviço (sem versão). */
  payments: '/payments/payments',
  /** Kind `notifications`; o serviço serve `/list` e `/update-state` na raiz. */
  notifications: '/notifications',
  /** Kind `reports`; rotas na raiz do serviço (`/events/{id}/summary`...). */
  reports: '/reports',
  /** Kind `certificates` + `/api/v1/certificates/...` do serviço. */
  certificates: '/certificates/api/v1/certificates',
} as const;

export function readConfig(env: Record<string, string | undefined> = import.meta.env): AppConfig {
  const raw = env['VITE_API_BASE_URL']?.trim();
  if (!raw) {
    throw new ConfigError(
      'VITE_API_BASE_URL não está definida. Copie frontend/.env.example para frontend/.env e informe a URL do Gateway.',
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(
      'VITE_API_BASE_URL deve ser uma URL absoluta, por exemplo https://gateway.example.com.',
    );
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError('VITE_API_BASE_URL deve usar http ou https.');
  }
  return { apiBaseUrl: `${url.origin}${url.pathname}`.replace(/\/+$/, '') };
}
