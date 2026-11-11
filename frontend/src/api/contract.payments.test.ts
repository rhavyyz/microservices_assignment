import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { API_PATHS } from '../config';
import { createServices } from '../services/createServices';
import {
  NOTIFICATION_ID,
  PAYMENT_ID,
  REGISTRATION_ID,
  notificationList,
  payment,
} from '../test/fixtures';
import { jsonResponse } from '../test/helpers';

/** Mesma ideia de contract.sources.test.ts: as rotas que o cliente chama existem no código dos serviços. */
const read = (rel: string) => readFileSync(resolve(process.cwd(), '..', rel), 'utf8');

function setup() {
  const calls: string[] = [];
  const f = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url.pathname}`);
    if (url.pathname.endsWith('/list')) return jsonResponse(200, notificationList([]));
    if (url.pathname.endsWith('/update-state'))
      return jsonResponse(200, { updated: 1, errors: {} });
    return jsonResponse(200, payment());
  });
  const services = createServices({ apiBaseUrl: 'https://gw.test' }, f);
  services.session.setToken('t');
  return { calls, ...services };
}

describe('Pagamentos', () => {
  it('as rotas chamadas existem em payments/src/server.ts e são públicas com requireAuth', async () => {
    const { calls, paymentsApi } = setup();
    await paymentsApi.createPayment(REGISTRATION_ID);
    await paymentsApi.getPayment(PAYMENT_ID);
    await paymentsApi.simulate(PAYMENT_ID, 'approve');

    const text = read('payments/src/server.ts');
    const known = new Set(
      [...text.matchAll(/app\.(get|post)\('([^']+)'/g)].map(
        (m) => `${m[1]!.toUpperCase()} ${m[2]!.replace(/:(\w+)/g, '{$1}')}`,
      ),
    );
    expect(known).toContain('POST /payments');
    for (const c of calls) {
      const [method, path] = c.split(' ') as [string, string];
      // `/payments` (kind do Gateway, removido) + rotas do serviço.
      const template = path.replace(/^\/payments/, '').replace(PAYMENT_ID, '{paymentId}');
      expect(known, `${c} -> ${method} ${template}`).toContain(`${method} ${template}`);
    }
    expect(text).toContain("PUBLIC_AUTH = { 'x-gateway': { isPublic: true, requireAuth: true } }");
  });

  it('o corpo da criação só leva registration_id (valor e dono vêm de Inscrições)', () => {
    const text = read('payments/src/contracts.ts');
    expect(text).toContain('registration_id');
    expect(text).toMatch(/Only `?registration_id`?|only the registration id/i);
  });
});

describe('Notificações', () => {
  it('as rotas /list e /update-state existem no OpenAPI do serviço, públicas com requireAuth', async () => {
    const { calls, notificationsApi } = setup();
    await notificationsApi.list({ status: ['DEFAULT'], limit: 5, base: NOTIFICATION_ID });
    await notificationsApi.updateStatus([{ id: NOTIFICATION_ID, status: 'SEEN' }]);

    const go = read('notifications/main.go');
    expect(go).toMatch(
      /"\/list": map\[string\]any\{\s*"get": map\[string\]any\{\s*"x-gateway": map\[string\]any\{"isPublic": true, "requireAuth": true\}/,
    );
    expect(go).toMatch(
      /"\/update-state": map\[string\]any\{\s*"put": map\[string\]any\{\s*"x-gateway": map\[string\]any\{"isPublic": true, "requireAuth": true\}/,
    );
    expect(calls).toEqual(['GET /notifications/list', 'PUT /notifications/update-state']);
  });

  it('o cliente envia os nomes de parâmetros que o serviço lê', () => {
    const go = read('notifications/api.go');
    for (const name of ['base_notification_id', 'status', 'limit', 'X-User-Id']) {
      expect(go, name).toContain(`"${name}"`);
    }
  });

  it('o tempo real é o WebSocket do Gateway: GET /ws com access_token e os quadros que o cliente entende', () => {
    const gw = ['main.go', 'ws.go', 'push.go', 'hub.go']
      .map((f) => read(`gateway/${f}`))
      .join('\n');
    expect(gw).toContain('GET /ws');
    expect(gw).toContain('"access_token"');
    expect(gw).toContain('{"type":"connected"}');
    expect(gw).toMatch(/json:"type"/);
    expect(gw).toContain('Type: "notification"');
    expect(gw).toMatch(/closeReplaced\s*=\s*4000/);
  });
});

it('os kinds do Gateway existem e os caminhos de config começam por eles', () => {
  const kinds = read('gateway/kinds.go');
  for (const kind of ['payments', 'notifications']) {
    expect(kinds).toContain(`"${kind}"`);
    expect(Object.values(API_PATHS).some((p) => p.startsWith(`/${kind}`))).toBe(true);
  }
});
