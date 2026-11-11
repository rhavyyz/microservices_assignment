import { API_PATHS } from '../config';
import type { ApiClient } from './client';
import {
  ActivityReportPageSchema,
  SummarySchema,
  type ActivityReportPage,
  type Summary,
} from './reportsSchemas';

/**
 * Indicadores do organizador. Só o dono do evento enxerga o relatório: evento alheio ou inexistente responde 404
 * `EVENT_NOT_FOUND` (indistinguíveis, RN07). Os números vêm de um modelo de leitura alimentado por Kafka, então
 * podem ficar alguns instantes atrás das telas operacionais.
 */
export function createReportsApi(client: ApiClient, basePath: string = API_PATHS.reports) {
  const id = encodeURIComponent;
  return {
    getSummary(eventId: string, signal?: AbortSignal): Promise<Summary> {
      return client.request({
        path: `${basePath}/events/${id(eventId)}/summary`,
        auth: true,
        schema: SummarySchema,
        localMessages: true,
        signal,
      });
    },

    listActivities(
      eventId: string,
      params: { limit?: number; offset?: number } = {},
      signal?: AbortSignal,
    ): Promise<ActivityReportPage> {
      return client.request({
        path: `${basePath}/events/${id(eventId)}/activities`,
        query: { limit: params.limit, offset: params.offset },
        auth: true,
        schema: ActivityReportPageSchema,
        localMessages: true,
        signal,
      });
    },
  };
}

export type ReportsApi = ReturnType<typeof createReportsApi>;
