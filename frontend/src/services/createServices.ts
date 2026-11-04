import { ApiClient } from '../api/client';
import { createUsersApi, type UsersApi } from '../api/usersApi';
import type { AppConfig } from '../config';

/** Ponte entre o cliente HTTP e a sessão: o token vive só aqui, em memória (ADR-006). */
export interface SessionBridge {
  getToken(): string | null;
  setToken(token: string | null): void;
  setUnauthorizedHandler(handler: (() => void) | null): void;
}

export interface Services {
  usersApi: UsersApi;
  session: SessionBridge;
}

export function createServices(config: AppConfig, fetchImpl?: typeof fetch): Services {
  let token: string | null = null;
  let unauthorized: (() => void) | null = null;

  const session: SessionBridge = {
    getToken: () => token,
    setToken: (t) => {
      token = t;
    },
    setUnauthorizedHandler: (h) => {
      unauthorized = h;
    },
  };

  const client = new ApiClient({
    baseUrl: config.apiBaseUrl,
    getToken: session.getToken,
    onUnauthorized: () => unauthorized?.(),
    ...(fetchImpl ? { fetchImpl } : {}),
  });

  return { usersApi: createUsersApi(client), session };
}
