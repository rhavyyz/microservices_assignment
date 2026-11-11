import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createServices } from '../services/createServices';
import { CERTIFICATE_ID, EVENT_ID, activityReportPage, reportSummary } from '../test/fixtures';
import { jsonResponse } from '../test/helpers';
import {
  ActivityReportSchema,
  AttendanceSchema,
  LifecycleCountsSchema,
  OccupancySchema,
  PaymentsSchema,
  RegistrationsSchema,
  ReportEventSchema,
} from './reportsSchemas';

/** Mesma ideia dos outros testes de contrato: o que o cliente chama e lê existe no código dos serviços. */
const read = (rel: string) => readFileSync(resolve(process.cwd(), '..', rel), 'utf8');

function setup() {
  const calls: string[] = [];
  const f = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`);
    if (url.pathname.endsWith('/summary')) return jsonResponse(200, reportSummary());
    if (url.pathname.endsWith('/activities')) return jsonResponse(200, activityReportPage([]));
    if (url.pathname.endsWith('/me')) return jsonResponse(200, { certificates: [] });
    return new Response(new TextEncoder().encode('%PDF'), {
      status: 200,
      headers: { 'Content-Type': 'application/pdf' },
    });
  });
  const services = createServices({ apiBaseUrl: 'https://gw.test' }, f);
  services.session.setToken('t');
  return { calls, ...services };
}

describe('Relatórios', () => {
  it('as rotas chamadas existem em reports/src/server.ts, públicas com requireAuth', async () => {
    const { calls, reportsApi } = setup();
    await reportsApi.getSummary(EVENT_ID);
    await reportsApi.listActivities(EVENT_ID, { limit: 20, offset: 0 });

    const text = read('reports/src/server.ts');
    const known = new Set(
      [...text.matchAll(/app\.get\('([^']+)'/g)].map((m) => m[1]!.replace(/:(\w+)/g, '{$1}')),
    );
    for (const c of calls) {
      const path = c.replace(/^GET \/reports/, '').replace(EVENT_ID, '{eventId}');
      expect(known, c).toContain(path);
    }
    expect(text).toContain("const businessRoute = { 'x-gateway': gatewaySettings");
    expect(text).toMatch(/gatewaySettings = \{ isPublic: true, requireAuth: true \}/);
  });

  it('cada campo que o cliente lê é produzido pelas consultas do serviço', () => {
    const queries = read('reports/src/queries.ts');
    const schemas = [
      RegistrationsSchema,
      PaymentsSchema,
      OccupancySchema,
      AttendanceSchema,
      ActivityReportSchema,
    ];
    for (const schema of schemas) {
      for (const key of Object.keys(schema.shape)) {
        expect(queries, `campo ${key}`).toContain(key);
      }
    }
  });

  it('cada campo exigido pelo cliente consta no schema de RESPOSTA do servidor (o que ele realmente serializa)', () => {
    // O Fastify serializa pelo schema de resposta: campo fora dele some do JSON, mesmo que a consulta SQL o traga.
    const server = read('reports/src/server.ts');
    const keysOf = (name: string): string[] => {
      const block = new RegExp(`const ${name} = obj\\(\\{([\\s\\S]*?)\\}\\);`).exec(server)?.[1];
      expect(block, `schema ${name} em server.ts`).toBeDefined();
      const withValue = [...block!.matchAll(/(?:^|[\s,{])([a-z_]+):/g)].map((m) => m[1]!);
      // propriedade abreviada (`rate` sem valor), como em occupancySchema
      const shorthand = [...block!.matchAll(/(?:^|[,{])\s*([a-z_]+)\s*(?=[,}]|$)/g)].map(
        (m) => m[1]!,
      );
      return [...withValue, ...shorthand].filter((k) => k !== 'type' && k !== 'format');
    };
    const pairs: [string, { shape: Record<string, unknown> }][] = [
      ['eventSchema', ReportEventSchema],
      ['registrationsSchema', RegistrationsSchema],
      ['paymentsSchema', PaymentsSchema],
      ['occupancySchema', OccupancySchema],
      ['attendanceSchema', AttendanceSchema],
      ['lifecycleCountsSchema', LifecycleCountsSchema],
      ['activitySchema', ActivityReportSchema],
    ];
    for (const [name, schema] of pairs) {
      const served = keysOf(name);
      expect(served.length, name).toBeGreaterThan(2);
      for (const key of Object.keys(schema.shape)) {
        expect(served, `${name}: o cliente exige "${key}", que o servidor não serializa`).toContain(
          key,
        );
      }
    }
  });

  it('o serviço usa centavos inteiros por moeda e taxa nula sem denominador (o que a tela assume)', () => {
    const readme = read('reports/README.md');
    expect(readme).toMatch(/integer minor units/i);
    expect(readme).toMatch(/Rates are `null` when the denominator is 0/);
  });
});

describe('Certificados', () => {
  it('as rotas chamadas existem em certificates/app/api/routes/certificates.py, protegidas', async () => {
    const { calls, certificatesApi } = setup();
    await certificatesApi.listMine({ limit: 50, offset: 0 });
    await certificatesApi.downloadPdf(CERTIFICATE_ID);

    const text = read('certificates/app/api/routes/certificates.py');
    const known = new Set(
      [...text.matchAll(/@router\.get\(\s*"([^"]+)"/g)].map((m) =>
        m[1]!.replace(/\{certificate_id\}/, '{id}'),
      ),
    );
    expect(calls).toEqual([
      'GET /certificates/api/v1/certificates/me',
      `GET /certificates/api/v1/certificates/${CERTIFICATE_ID}`,
    ]);
    expect(known).toContain('/api/v1/certificates/me');
    expect(known).toContain('/api/v1/certificates/{id}');
    expect(text).toContain(
      'GATEWAY_PROTECTED = {"x-gateway": {"isPublic": True, "requireAuth": True}}',
    );
    expect(text).toContain('media_type="application/pdf"');
  });

  it('não existe rota de criação: o serviço emite sozinho (a tela só lista e baixa)', () => {
    const text = read('certificates/app/api/routes/certificates.py');
    expect(text).not.toMatch(/@router\.(post|put|patch|delete)/);
  });

  it('os campos do resumo existem no schema do serviço', () => {
    const py = read('certificates/app/schemas/certificate.py');
    for (const f of ['id', 'registration_id', 'activity_id', 'event_id', 'issued_at']) {
      expect(py).toContain(`${f}:`);
    }
  });
});
