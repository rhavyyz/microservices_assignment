import { z } from 'zod';

/**
 * Schemas das respostas do serviço de Usuários (docs/api/users.openapi.yaml). Os tipos TypeScript saem daqui, e
 * cada resposta é validada em tempo de execução: uma resposta fora do contrato vira INVALID_RESPONSE.
 * `contract.test.ts` compara estes schemas com o OpenAPI.
 */
export const RoleSchema = z.enum(['PARTICIPANT', 'ORGANIZER']);
export const UserStatusSchema = z.enum(['ACTIVE', 'INACTIVE']);

export const UserSummarySchema = z.object({
  id: z.guid(),
  name: z.string(),
  email: z.string(),
  roles: z.array(RoleSchema),
});

export const UserProfileSchema = z.object({
  id: z.guid(),
  name: z.string(),
  email: z.string(),
  roles: z.array(RoleSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const LoginResponseSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.literal('Bearer'),
  expiresIn: z.number().int().positive(),
  user: UserSummarySchema,
});

export const UserListItemSchema = z.object({
  id: z.guid(),
  name: z.string(),
  email: z.string(),
  roles: z.array(RoleSchema),
  status: UserStatusSchema,
});

export const UserPageSchema = z.object({
  items: z.array(UserListItemSchema),
  page: z.number().int(),
  size: z.number().int(),
  totalElements: z.number().int(),
  totalPages: z.number().int(),
});

export type Role = z.infer<typeof RoleSchema>;
export type UserSummary = z.infer<typeof UserSummarySchema>;
export type UserProfile = z.infer<typeof UserProfileSchema>;
export type LoginResponse = z.infer<typeof LoginResponseSchema>;
export type UserListItem = z.infer<typeof UserListItemSchema>;
export type UserPage = z.infer<typeof UserPageSchema>;
