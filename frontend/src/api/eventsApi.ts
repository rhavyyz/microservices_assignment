import { API_PATHS } from '../config';
import type { ApiClient } from './client';
import {
  ActivitySchema,
  EventDetailSchema,
  EventPageSchema,
  EventSchema,
  type Activity,
  type EventItem,
  type EventDetail,
  type EventPage,
} from './eventsSchemas';

/** Corpo de criação/edição de evento (events/src/http/schemas.ts: `eventFields`). Datas em ISO 8601. */
export interface EventInput {
  title: string;
  organization?: string | null;
  description?: string | null;
  location?: string | null;
  banner_url?: string | null;
  starts_at: string;
  ends_at: string;
}

/** Corpo de criação de atividade (`activityFields` + `capacity`, esta imutável depois de criada). */
export interface ActivityInput {
  title: string;
  description?: string | null;
  speaker?: string | null;
  location?: string | null;
  starts_at: string;
  ends_at: string;
  amount_minor: number;
  waitlist_enabled: boolean;
  capacity: number;
}

/** Edição de atividade: sem `capacity` (enviar é 400 no serviço). */
export type ActivityPatch = Partial<Omit<ActivityInput, 'capacity'>>;

export interface EventSearchParams {
  q?: string | undefined;
  /** ISO 8601: eventos que terminam neste instante ou depois. */
  from?: string | undefined;
  /** ISO 8601: eventos que começam neste instante ou antes. */
  to?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * Leituras públicas do serviço de Eventos. São chamadas SEM token de propósito: o serviço responde 401 a um token
 * inválido até nas leituras públicas, e o catálogo não precisa de identidade. Via Gateway: `/events/<caminho>`.
 */
export function createEventsApi(client: ApiClient, basePath: string = API_PATHS.events) {
  const id = encodeURIComponent;
  return {
    listEvents(params: EventSearchParams, signal?: AbortSignal): Promise<EventPage> {
      return client.request({
        path: `${basePath}/events`,
        query: {
          q: params.q,
          from: params.from,
          to: params.to,
          limit: params.limit,
          offset: params.offset,
        },
        schema: EventPageSchema,
        localMessages: true,
        signal,
      });
    },

    /** `auth: true` só na área do organizador: com token, o dono também enxerga o rascunho. */
    getEvent(
      eventId: string,
      signal?: AbortSignal,
      opts: { auth?: boolean } = {},
    ): Promise<EventDetail> {
      return client.request({
        path: `${basePath}/events/${id(eventId)}`,
        auth: opts.auth ?? false,
        schema: EventDetailSchema,
        localMessages: true,
        signal,
      });
    },

    // ---- Área do organizador: tudo abaixo exige token (`requireAuth` no Gateway). A autorização por recurso
    // (só o organizador do evento) é do serviço; o frontend apenas esconde o que não cabe ao usuário.

    /** Eventos do próprio usuário, rascunhos incluídos. */
    listMyEvents(
      params: { limit?: number; offset?: number } = {},
      signal?: AbortSignal,
    ): Promise<EventPage> {
      return client.request({
        path: `${basePath}/me/events`,
        query: { limit: params.limit, offset: params.offset },
        auth: true,
        schema: EventPageSchema,
        localMessages: true,
        signal,
      });
    },

    createEvent(input: EventInput, signal?: AbortSignal): Promise<EventItem> {
      return client.request({
        method: 'POST',
        path: `${basePath}/events`,
        body: input,
        auth: true,
        schema: EventSchema,
        localMessages: true,
        signal,
      });
    },

    updateEvent(
      eventId: string,
      patch: Partial<EventInput>,
      signal?: AbortSignal,
    ): Promise<EventItem> {
      return client.request({
        method: 'PATCH',
        path: `${basePath}/events/${id(eventId)}`,
        body: patch,
        auth: true,
        schema: EventSchema,
        localMessages: true,
        signal,
      });
    },

    publishEvent(eventId: string, signal?: AbortSignal): Promise<EventItem> {
      return client.request({
        method: 'POST',
        path: `${basePath}/events/${id(eventId)}/publish`,
        auth: true,
        schema: EventSchema,
        localMessages: true,
        signal,
      });
    },

    cancelEvent(eventId: string, signal?: AbortSignal): Promise<EventItem> {
      return client.request({
        method: 'POST',
        path: `${basePath}/events/${id(eventId)}/cancel`,
        auth: true,
        schema: EventSchema,
        localMessages: true,
        signal,
      });
    },

    addActivity(eventId: string, input: ActivityInput, signal?: AbortSignal): Promise<Activity> {
      return client.request({
        method: 'POST',
        path: `${basePath}/events/${id(eventId)}/activities`,
        body: input,
        auth: true,
        schema: ActivitySchema,
        localMessages: true,
        signal,
      });
    },

    updateActivity(
      activityId: string,
      patch: ActivityPatch,
      signal?: AbortSignal,
    ): Promise<Activity> {
      return client.request({
        method: 'PATCH',
        path: `${basePath}/activities/${id(activityId)}`,
        body: patch,
        auth: true,
        schema: ActivitySchema,
        localMessages: true,
        signal,
      });
    },

    /** Só depois do horário previsto de término; repetir é inofensivo (idempotente no serviço). */
    endActivity(activityId: string, signal?: AbortSignal): Promise<Activity> {
      return client.request({
        method: 'POST',
        path: `${basePath}/activities/${id(activityId)}/end`,
        auth: true,
        schema: ActivitySchema,
        localMessages: true,
        signal,
      });
    },

    /** Só em evento rascunho. Responde 204 (sem corpo). */
    deleteActivity(activityId: string, signal?: AbortSignal): Promise<void> {
      return client.request({
        method: 'DELETE',
        path: `${basePath}/activities/${id(activityId)}`,
        auth: true,
        localMessages: true,
        signal,
      });
    },

    getActivity(activityId: string, signal?: AbortSignal): Promise<Activity> {
      return client.request({
        path: `${basePath}/activities/${id(activityId)}`,
        schema: ActivitySchema,
        localMessages: true,
        signal,
      });
    },
  };
}

export type EventsApi = ReturnType<typeof createEventsApi>;
