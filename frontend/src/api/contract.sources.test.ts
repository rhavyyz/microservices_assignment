import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { API_PATHS } from '../config';
import { createServices } from '../services/createServices';
import {
  ACTIVITY_ID,
  EVENT_ID,
  REGISTRATION_ID,
  activity,
  attendance,
  availability,
  event,
  eventDetail,
  eventPage,
  registration,
} from '../test/fixtures';
import { jsonResponse } from '../test/helpers';

/**
 * As rotas que o cliente chama precisam existir no CÓDIGO dos serviços (monorrepo: os testes rodam em frontend/).
 * Um serviço que renomeie uma rota quebra este teste, em vez de quebrar a tela em silêncio.
 */
const read = (rel: string) => readFileSync(resolve(process.cwd(), '..', rel), 'utf8');

function eventsRoutes(): Set<string> {
  const text = read('events/src/http/routes.ts');
  const api = /const API = '([^']+)'/.exec(text)?.[1] ?? '';
  expect(api, 'prefixo API não encontrado em routes.ts').not.toBe('');
  return new Set(
    [...text.matchAll(/app\.(get|post|put|patch|delete)\(\s*[`']([^`']+)[`']/g)].map(
      (m) => `${m[1]!.toUpperCase()} ${m[2]!.replace('${API}', api).replace(/:(\w+)/g, '{$1}')}`,
    ),
  );
}

function subscriptionRoutes(): Set<string> {
  const text = read('subscription/app/api.py');
  return new Set(
    [...text.matchAll(/@app\.(get|post|put|patch|delete)\(\s*"([^"]+)"/g)].map(
      (m) => `${m[1]!.toUpperCase()} ${m[2]!}`,
    ),
  );
}

function recordCalls() {
  const calls: string[] = [];
  const f = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname;
    calls.push(`${method} ${path}`);
    if (method === 'DELETE') return new Response(null, { status: 204 });
    if (path.endsWith('/check-in')) return jsonResponse(200, attendance());
    if (path.endsWith('/availability')) return jsonResponse(200, availability());
    if (/\/activities\/[^/]+\/registrations$/.test(path) && method === 'GET')
      return jsonResponse(200, { registrations: [] });
    if (path.endsWith('/registrations/me')) return jsonResponse(200, { registrations: [] });
    if (path.includes('/registrations')) return jsonResponse(200, registration());
    // Eventos: escritas devolvem a entidade; leituras, a página ou o detalhe.
    if (/\/(events\/[^/]+\/activities|activities\/[^/]+(\/end)?)$/.test(path))
      return jsonResponse(200, activity());
    if (method !== 'GET') return jsonResponse(200, event());
    if (/\/(me\/)?events$/.test(path)) return jsonResponse(200, eventPage([]));
    return jsonResponse(200, eventDetail());
  });
  const { eventsApi, subscriptionApi, session } = createServices(
    { apiBaseUrl: 'https://gw.test' },
    f,
  );
  session.setToken('t');
  return { calls, eventsApi, subscriptionApi };
}

describe('rotas chamadas pelo frontend existem no código dos serviços', () => {
  it('Eventos', async () => {
    const { calls, eventsApi } = recordCalls();
    await eventsApi.listEvents({});
    await eventsApi.getEvent(EVENT_ID);
    await eventsApi.getActivity(ACTIVITY_ID);
    // Área do organizador
    const input = { title: 't', starts_at: 'a', ends_at: 'b' };
    const activityInput = { ...input, amount_minor: 0, waitlist_enabled: false, capacity: 1 };
    await eventsApi.listMyEvents();
    await eventsApi.createEvent(input);
    await eventsApi.updateEvent(EVENT_ID, { title: 'x' });
    await eventsApi.publishEvent(EVENT_ID);
    await eventsApi.cancelEvent(EVENT_ID);
    await eventsApi.addActivity(EVENT_ID, activityInput);
    await eventsApi.updateActivity(ACTIVITY_ID, { title: 'x' });
    await eventsApi.endActivity(ACTIVITY_ID);
    await eventsApi.deleteActivity(ACTIVITY_ID);
    const known = eventsRoutes();
    expect(known.size).toBeGreaterThan(5);
    for (const c of calls) {
      const [method, path] = c.split(' ') as [string, string];
      const template = path
        .replace(/^\/events/, '')
        .replace(EVENT_ID, '{event_id}')
        .replace(ACTIVITY_ID, '{activity_id}');
      expect(known, `${c} -> ${method} ${template}`).toContain(`${method} ${template}`);
    }
  });

  it('Inscrições', async () => {
    const { calls, subscriptionApi } = recordCalls();
    await subscriptionApi.createRegistration(ACTIVITY_ID, false);
    await subscriptionApi.getAvailability(ACTIVITY_ID);
    await subscriptionApi.listMine();
    await subscriptionApi.getRegistration(REGISTRATION_ID);
    await subscriptionApi.cancelRegistration(REGISTRATION_ID);
    await subscriptionApi.acceptOffer(REGISTRATION_ID);
    await subscriptionApi.listParticipants(ACTIVITY_ID);
    await subscriptionApi.checkIn(REGISTRATION_ID);
    const known = subscriptionRoutes();
    expect(known.size).toBeGreaterThan(6);
    for (const c of calls) {
      const [method, path] = c.split(' ') as [string, string];
      const template = path
        .replace(/^\/subscription/, '')
        .replace(ACTIVITY_ID, '{activity_id}')
        .replace(REGISTRATION_ID, '{registration_id}');
      expect(known, `${c} -> ${method} ${template}`).toContain(`${method} ${template}`);
    }
  });

  it('os nomes de serviço no caminho (/events, /subscription) são kinds do Gateway', () => {
    const kinds = read('gateway/kinds.go');
    for (const kind of ['events', 'subscription', 'user']) {
      expect(kinds).toContain(`"${kind}"`);
      expect(Object.values(API_PATHS).some((p) => p.startsWith(`/${kind}`))).toBe(true);
    }
  });
});
