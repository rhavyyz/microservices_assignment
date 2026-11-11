import { API_PATHS } from '../config';
import type { ApiClient } from './client';
import {
  AdminUserItemSchema,
  AdminUserPageSchema,
  LoginResponseSchema,
  UserPageSchema,
  UserProfileSchema,
  type AdminUserItem,
  type AdminUserPage,
  type LoginResponse,
  type OrganizerRequest,
  type UserPage,
  type UserProfile,
} from './schemas';

export interface RegisterInput {
  name: string;
  email: string;
  password: string;
  /** ORGANIZER só abre um pedido: o papel é concedido por um administrador. */
  requestedRole?: 'PARTICIPANT' | 'ORGANIZER' | undefined;
}

export interface LoginInput {
  email: string;
  password: string;
}

export interface AdminListParams {
  q?: string | undefined;
  organizerRequest?: OrganizerRequest | undefined;
  page?: number | undefined;
  size?: number | undefined;
}

export interface UserSearchParams {
  id?: string | undefined;
  email?: string | undefined;
  name?: string | undefined;
  page?: number | undefined;
  size?: number | undefined;
}

/** Funções tipadas do serviço de Usuários (contrato: docs/api/users.openapi.yaml). */
export function createUsersApi(client: ApiClient, basePath: string = API_PATHS.users) {
  return {
    register(input: RegisterInput, signal?: AbortSignal): Promise<UserProfile> {
      return client.request({
        method: 'POST',
        path: `${basePath}/auth/register`,
        body: {
          name: input.name,
          email: input.email,
          password: input.password,
          requestedRole: input.requestedRole ?? 'PARTICIPANT',
        },
        schema: UserProfileSchema,
        signal,
      });
    },

    login(input: LoginInput, signal?: AbortSignal): Promise<LoginResponse> {
      return client.request({
        method: 'POST',
        path: `${basePath}/auth/login`,
        body: { email: input.email, password: input.password },
        schema: LoginResponseSchema,
        signal,
      });
    },

    getMe(signal?: AbortSignal): Promise<UserProfile> {
      return client.request({
        path: `${basePath}/users/me`,
        auth: true,
        schema: UserProfileSchema,
        signal,
      });
    },

    updateMe(input: { name: string }, signal?: AbortSignal): Promise<UserProfile> {
      return client.request({
        method: 'PATCH',
        path: `${basePath}/users/me`,
        body: { name: input.name },
        auth: true,
        schema: UserProfileSchema,
        signal,
      });
    },

    /** Somente ORGANIZER: o backend recusa os demais com 403, independentemente da interface. */
    searchUsers(params: UserSearchParams, signal?: AbortSignal): Promise<UserPage> {
      return client.request({
        path: `${basePath}/users`,
        query: {
          id: params.id,
          email: params.email,
          name: params.name,
          page: params.page,
          size: params.size,
        },
        auth: true,
        schema: UserPageSchema,
        signal,
      });
    },

    /** Somente ADMIN: todos os usuários, com o pedido de organizador. O servidor recusa os demais com 403. */
    adminListUsers(params: AdminListParams, signal?: AbortSignal): Promise<AdminUserPage> {
      return client.request({
        path: `${basePath}/admin/users`,
        query: {
          q: params.q,
          organizerRequest: params.organizerRequest,
          page: params.page,
          size: params.size,
        },
        auth: true,
        schema: AdminUserPageSchema,
        signal,
      });
    },

    /** Somente ADMIN: `approved=true` concede ORGANIZER; `false` nega o pedido ou retira o papel. */
    adminDecideOrganizer(
      id: string,
      approved: boolean,
      signal?: AbortSignal,
    ): Promise<AdminUserItem> {
      return client.request({
        method: 'PUT',
        path: `${basePath}/admin/users/${encodeURIComponent(id)}/organizer`,
        body: { approved },
        auth: true,
        schema: AdminUserItemSchema,
        signal,
      });
    },
  };
}

export type UsersApi = ReturnType<typeof createUsersApi>;
