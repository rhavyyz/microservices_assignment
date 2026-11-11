import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { z } from 'zod';
import { API_PATHS } from '../config';
import { createServices } from '../services/createServices';
import { jsonResponse, loginBody, profile } from '../test/helpers';
import {
  AdminUserItemSchema,
  AdminUserPageSchema,
  LoginResponseSchema,
  UserListItemSchema,
  UserPageSchema,
  UserProfileSchema,
  UserSummarySchema,
} from './schemas';

interface OpenApiSchema {
  $ref?: string;
  allOf?: OpenApiSchema[];
  required?: string[];
  properties?: Record<string, unknown>;
}
interface OpenApiDoc {
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, OpenApiSchema> };
}

// O OpenAPI do serviço de Usuários é a fonte do contrato: schemas do cliente e rotas chamadas devem coincidir com ele.
const doc = parse(
  // Os testes rodam a partir de frontend/ (npm test), então o monorrepo fica um nível acima.
  readFileSync(resolve(process.cwd(), '../docs/api/users.openapi.yaml'), 'utf8'),
) as OpenApiDoc;

/** Schema efetivo: resolve $ref e junta allOf (propriedades e obrigatórios). */
function effective(schema: OpenApiSchema): { properties: string[]; required: string[] } {
  if (schema.$ref) {
    const target = doc.components.schemas[schema.$ref.split('/').pop()!];
    if (!target) throw new Error(`$ref sem destino: ${schema.$ref}`);
    return effective(target);
  }
  const parts = (schema.allOf ?? []).map(effective);
  return {
    properties: [
      ...Object.keys(schema.properties ?? {}),
      ...parts.flatMap((p) => p.properties),
    ].sort(),
    required: [...(schema.required ?? []), ...parts.flatMap((p) => p.required)].sort(),
  };
}

describe('contrato com docs/api/users.openapi.yaml', () => {
  const cases: [string, z.ZodObject<z.ZodRawShape>][] = [
    ['UserSummary', UserSummarySchema],
    ['UserProfile', UserProfileSchema],
    ['LoginResponse', LoginResponseSchema as unknown as z.ZodObject<z.ZodRawShape>],
    ['UserListItem', UserListItemSchema],
    ['UserPage', UserPageSchema],
    ['AdminUserItem', AdminUserItemSchema],
    ['AdminUserPage', AdminUserPageSchema],
  ];

  it.each(cases)(
    'o schema %s tem as mesmas propriedades e obrigatórios do OpenAPI',
    (name, zod) => {
      const spec = doc.components.schemas[name];
      expect(spec, `schema ${name} ausente no OpenAPI`).toBeDefined();
      const eff = effective(spec!);
      expect(Object.keys(zod.shape).sort()).toEqual(eff.properties);
      // Todos os campos da resposta são obrigatórios no contrato e no schema do cliente.
      expect(eff.required).toEqual(Object.keys(zod.shape).sort());
    },
  );

  it('as chamadas do cliente correspondem a rotas e métodos do OpenAPI (após o prefixo /user do Gateway)', async () => {
    const calls: { method: string; path: string }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const path = url.pathname.replace(/^\/user/, '');
      calls.push({ method: (init?.method ?? 'GET').toLowerCase(), path });
      if (path.endsWith('/login')) return jsonResponse(200, loginBody());
      if (path.endsWith('/users'))
        return jsonResponse(200, { items: [], page: 0, size: 10, totalElements: 0, totalPages: 0 });
      return jsonResponse(200, profile());
    });
    const { usersApi, session } = createServices({ apiBaseUrl: 'https://gateway.test' }, fetchImpl);
    session.setToken('t');
    await usersApi.register({
      name: 'Maria',
      email: 'maria@example.com',
      password: 'senha-forte-123',
    });
    await usersApi.login({ email: 'maria@example.com', password: 'senha-forte-123' });
    await usersApi.getMe();
    await usersApi.updateMe({ name: 'Maria' });
    await usersApi.searchUsers({ name: 'ma' });

    expect(calls).toHaveLength(5);
    for (const c of calls) {
      expect(
        doc.paths[c.path]?.[c.method],
        `${c.method.toUpperCase()} ${c.path} não existe no OpenAPI`,
      ).toBeDefined();
    }
    expect(API_PATHS.users).toBe('/user/api/v1');
  });

  it('as chamadas de administração correspondem às rotas do OpenAPI e a RegisterRequest aceita requestedRole', async () => {
    const calls: { method: string; path: string }[] = [];
    const item = {
      id: '00000000-0000-4000-8000-000000000001',
      name: 'Ana',
      email: 'ana@example.com',
      roles: ['PARTICIPANT'],
      status: 'ACTIVE',
      organizerRequest: 'PENDING',
      organizerRequestUpdatedAt: null,
      createdAt: '2026-11-03T23:25:45Z',
    };
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      const path = new URL(String(input)).pathname.replace(/^\/user/, '');
      calls.push({ method: (init?.method ?? 'GET').toLowerCase(), path });
      return path.endsWith('/organizer')
        ? jsonResponse(200, item)
        : jsonResponse(200, { items: [item], page: 0, size: 20, totalElements: 1, totalPages: 1 });
    });
    const { usersApi, session } = createServices({ apiBaseUrl: 'https://gateway.test' }, fetchImpl);
    session.setToken('t');
    await usersApi.adminListUsers({ organizerRequest: 'PENDING' });
    await usersApi.adminDecideOrganizer(item.id, true);

    // o OpenAPI usa {id}; a chamada real traz o UUID
    expect(calls[0]).toEqual({ method: 'get', path: '/api/v1/admin/users' });
    expect(calls[1]).toEqual({
      method: 'put',
      path: `/api/v1/admin/users/${item.id}/organizer`,
    });
    expect(doc.paths['/api/v1/admin/users']?.get).toBeDefined();
    expect(doc.paths['/api/v1/admin/users/{id}/organizer']?.put).toBeDefined();
    const reg = effective(doc.components.schemas.RegisterRequest!);
    expect(reg.properties).toContain('requestedRole');
    expect(reg.required).not.toContain('requestedRole');
    const roles = doc.components.schemas.Role as unknown as { enum: string[] };
    expect(roles.enum).toEqual(['PARTICIPANT', 'ORGANIZER', 'ADMIN']);
  });
});
