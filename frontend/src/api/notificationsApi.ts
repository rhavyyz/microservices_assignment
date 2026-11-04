import { API_PATHS } from '../config';
import type { ApiClient } from './client';
import {
  NotificationListSchema,
  UpdateStateSchema,
  type NotificationList,
  type NotificationStatus,
  type UpdateState,
} from './notificationsSchemas';

/**
 * Notificações do usuário autenticado. O serviço responde texto puro nos erros (400/401/404/500); o cliente
 * trata isso pelo código HTTP. O tempo real é o WebSocket do Gateway (`notificationsSocket.ts`).
 */
export function createNotificationsApi(
  client: ApiClient,
  basePath: string = API_PATHS.notifications,
) {
  return {
    /** Mais recentes primeiro; `base` (cursor) pede as mais antigas que ela. `status` repetível. */
    list(
      params: { status?: readonly NotificationStatus[]; limit?: number; base?: string } = {},
      signal?: AbortSignal,
    ): Promise<NotificationList> {
      return client.request({
        path: `${basePath}/list`,
        query: {
          status: params.status?.length ? params.status.join(',') : undefined,
          limit: params.limit,
          base_notification_id: params.base,
        },
        auth: true,
        schema: NotificationListSchema,
        signal,
      });
    },

    /** Muda o status de até 100 notificações do próprio usuário (qualquer status para qualquer status). */
    updateStatus(
      items: readonly { id: string; status: NotificationStatus }[],
      signal?: AbortSignal,
    ): Promise<UpdateState> {
      return client.request({
        method: 'PUT',
        path: `${basePath}/update-state`,
        body: items,
        auth: true,
        schema: UpdateStateSchema,
        signal,
      });
    },
  };
}

export type NotificationsApi = ReturnType<typeof createNotificationsApi>;
