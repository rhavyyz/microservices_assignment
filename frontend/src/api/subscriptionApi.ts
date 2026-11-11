import { API_PATHS } from '../config';
import type { ApiClient } from './client';
import {
  AttendanceSchema,
  AvailabilitySchema,
  RegistrationListSchema,
  RegistrationSchema,
  type Attendance,
  type Availability,
  type Registration,
} from './subscriptionSchemas';

/** Todas as rotas exigem token (`requireAuth` no Gateway). Via Gateway: `/subscription/api/v1/...`. */
export function createSubscriptionApi(
  client: ApiClient,
  basePath: string = API_PATHS.subscription,
) {
  const id = encodeURIComponent;
  return {
    /** Idempotente por (pessoa, atividade): repetir devolve a inscrição viva (200) em vez de criar outra (201). */
    createRegistration(
      activityId: string,
      joinWaitlist: boolean,
      signal?: AbortSignal,
    ): Promise<Registration> {
      return client.request({
        method: 'POST',
        path: `${basePath}/activities/${id(activityId)}/registrations`,
        body: { join_waitlist: joinWaitlist },
        auth: true,
        schema: RegistrationSchema,
        localMessages: true,
        signal,
      });
    },

    /** Vagas livres. Exige login (`requireAuth` no Gateway), então visitantes só veem a capacidade. */
    getAvailability(activityId: string, signal?: AbortSignal): Promise<Availability> {
      return client.request({
        path: `${basePath}/activities/${id(activityId)}/availability`,
        auth: true,
        schema: AvailabilitySchema,
        localMessages: true,
        signal,
      });
    },

    async listMine(
      params: { limit?: number; offset?: number } = {},
      signal?: AbortSignal,
    ): Promise<Registration[]> {
      const page = await client.request({
        path: `${basePath}/registrations/me`,
        query: { limit: params.limit, offset: params.offset },
        auth: true,
        schema: RegistrationListSchema,
        localMessages: true,
        signal,
      });
      return page.registrations;
    },

    getRegistration(registrationId: string, signal?: AbortSignal): Promise<Registration> {
      return client.request({
        path: `${basePath}/registrations/${id(registrationId)}`,
        auth: true,
        schema: RegistrationSchema,
        localMessages: true,
        signal,
      });
    },

    cancelRegistration(registrationId: string, signal?: AbortSignal): Promise<Registration> {
      return client.request({
        method: 'POST',
        path: `${basePath}/registrations/${id(registrationId)}/cancel`,
        auth: true,
        schema: RegistrationSchema,
        localMessages: true,
        signal,
      });
    },

    acceptOffer(registrationId: string, signal?: AbortSignal): Promise<Registration> {
      return client.request({
        method: 'POST',
        path: `${basePath}/registrations/${id(registrationId)}/accept-offer`,
        auth: true,
        schema: RegistrationSchema,
        localMessages: true,
        signal,
      });
    },

    // ---- Organizador (o serviço responde 403 a quem não administra a atividade) ----

    async listParticipants(
      activityId: string,
      params: { limit?: number; offset?: number } = {},
      signal?: AbortSignal,
    ): Promise<Registration[]> {
      const page = await client.request({
        path: `${basePath}/activities/${id(activityId)}/registrations`,
        query: { limit: params.limit, offset: params.offset },
        auth: true,
        schema: RegistrationListSchema,
        localMessages: true,
        signal,
      });
      return page.registrations;
    },

    /** Idempotente: repetir devolve a presença já registrada. Só em inscrição CONFIRMED, dentro do horário. */
    checkIn(registrationId: string, signal?: AbortSignal): Promise<Attendance> {
      return client.request({
        method: 'POST',
        path: `${basePath}/registrations/${id(registrationId)}/check-in`,
        auth: true,
        schema: AttendanceSchema,
        localMessages: true,
        signal,
      });
    },
  };
}

export type SubscriptionApi = ReturnType<typeof createSubscriptionApi>;
