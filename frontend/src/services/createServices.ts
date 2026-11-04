import { ApiClient } from '../api/client';
import { createEventsApi, type EventsApi } from '../api/eventsApi';
import { NotificationsSocket, type NotificationsSocketOptions } from '../api/notificationsSocket';
import { createCertificatesApi, type CertificatesApi } from '../api/certificatesApi';
import { createReportsApi, type ReportsApi } from '../api/reportsApi';
import { createNotificationsApi, type NotificationsApi } from '../api/notificationsApi';
import { createPaymentsApi, type PaymentsApi } from '../api/paymentsApi';
import { createSubscriptionApi, type SubscriptionApi } from '../api/subscriptionApi';
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
  eventsApi: EventsApi;
  subscriptionApi: SubscriptionApi;
  paymentsApi: PaymentsApi;
  notificationsApi: NotificationsApi;
  reportsApi: ReportsApi;
  certificatesApi: CertificatesApi;
  /** Abre o tempo real das notificações (WebSocket do Gateway) com o token em memória. */
  createNotificationsSocket(
    handlers: Pick<NotificationsSocketOptions, 'onNotification' | 'onLive'>,
  ): NotificationsSocket;
  session: SessionBridge;
}

export function createServices(
  config: AppConfig,
  fetchImpl?: typeof fetch,
  webSocketImpl?: NotificationsSocketOptions['WebSocketImpl'],
): Services {
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

  return {
    usersApi: createUsersApi(client),
    eventsApi: createEventsApi(client),
    subscriptionApi: createSubscriptionApi(client),
    paymentsApi: createPaymentsApi(client),
    notificationsApi: createNotificationsApi(client),
    reportsApi: createReportsApi(client),
    certificatesApi: createCertificatesApi(client),
    createNotificationsSocket: (handlers) =>
      new NotificationsSocket({
        baseUrl: config.apiBaseUrl,
        getToken: session.getToken,
        ...(webSocketImpl ? { WebSocketImpl: webSocketImpl } : {}),
        ...handlers,
      }),
    session,
  };
}
