// The HTTP surface end to end (routes, schemas, identity headers, problem+json) over the in-memory database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerRoutes } from '../src/http/routes.ts';
import { buildServer } from '../src/http/server.ts';
import { d, fakeService, ORGANIZER_ID, OTHER_ID } from './fakes.ts';

const org = { 'x-user-id': ORGANIZER_ID, 'x-user-roles': 'ORGANIZER' };
const stranger = { 'x-user-id': OTHER_ID, 'x-user-roles': 'ORGANIZER' };

async function api() {
  const s = fakeService(d('2030-05-01T08:30:00Z'));
  s.db.seedEvent();
  s.db.seedActivity();
  const app = await buildServer({ pool: s.db.pool, isReady: () => true, logger: false });
  registerRoutes(app, { events: s.events });
  return { app, ...s };
}

test('public reads work without identity and use event_id / activity_id', async () => {
  const { app } = await api();
  const list = await app.inject({ method: 'GET', url: '/api/v1/events' });
  assert.equal(list.statusCode, 200);
  assert.deepEqual(Object.keys(list.json()).sort(), ['items', 'limit', 'offset', 'total']);

  const detail = (await app.inject({ method: 'GET', url: '/api/v1/events/11111111-0000-4000-8000-000000000000' }));
  assert.equal(detail.statusCode, 404);
  assert.equal(detail.headers['content-type'], 'application/problem+json; charset=utf-8');
});

test('the activity is served under /api/v1 with Subscription\'s fields and no seat counts', async () => {
  const s = await api();
  s.db.seedActivity({ id: '33333333-3333-4333-8333-333333333333' });
  const res = await s.app.inject({ method: 'GET', url: '/api/v1/activities/33333333-3333-4333-8333-333333333333' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.activity_id, '33333333-3333-4333-8333-333333333333');
  assert.equal(body.event_id, 'e1');
  assert.equal(body.amount_minor, 5000);
  assert.equal(body.currency, 'BRL');
  assert.equal(body.lifecycle, 'OPEN');
  assert.equal(body.ended_at, null);
  assert.equal(body.registration_open, true);
  for (const gone of ['id', 'price_cents', 'available', 'reserved']) assert.equal(gone in body, false, gone);
  assert.equal((await s.app.inject({ method: 'GET', url: '/activities/33333333-3333-4333-8333-333333333333' })).statusCode, 404);
});

test('an invalid X-User-Id is a 401 even on a public read', async () => {
  const { app } = await api();
  const res = await app.inject({ method: 'GET', url: '/api/v1/events', headers: { 'x-user-id': 'nope' } });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, 'UNAUTHENTICATED');
});

test('mutating routes and /me/events need an identity: 401 UNAUTHENTICATED as problem+json', async () => {
  const { app } = await api();
  const id = '33333333-3333-4333-8333-333333333333';
  const calls: [string, string][] = [
    ['GET', '/api/v1/me/events'], ['POST', '/api/v1/events'], ['PATCH', `/api/v1/events/${id}`], ['POST', `/api/v1/events/${id}/publish`],
    ['POST', `/api/v1/events/${id}/cancel`], ['POST', `/api/v1/events/${id}/activities`], ['PATCH', `/api/v1/activities/${id}`],
    ['POST', `/api/v1/activities/${id}/end`], ['DELETE', `/api/v1/activities/${id}`], ['GET', `/api/v1/activities/${id}/permissions/me`],
  ];
  for (const [method, url] of calls) {
    const res = await app.inject({ method: method as 'GET', url, headers: { authorization: 'Bearer token' }, ...(method === 'POST' && url.endsWith('/events') ? { payload: {} } : {}) });
    assert.equal(res.statusCode, 401, `${method} ${url}`);
    assert.equal(res.json().code, 'UNAUTHENTICATED');
    assert.match(String(res.headers['content-type']), /application\/problem\+json/);
  }
});

test('permissions/me answers can_manage: true for the organizer, false for others, 404 for an unknown activity', async () => {
  const s = await api();
  const id = '44444444-4444-4444-8444-444444444444';
  s.db.seedActivity({ id });
  const url = `/api/v1/activities/${id}/permissions/me`;
  assert.deepEqual((await s.app.inject({ method: 'GET', url, headers: org })).json(), { can_manage: true });
  assert.deepEqual((await s.app.inject({ method: 'GET', url, headers: stranger })).json(), { can_manage: false });
  const missing = await s.app.inject({ method: 'GET', url: '/api/v1/activities/55555555-5555-4555-8555-555555555555/permissions/me', headers: org });
  assert.equal(missing.statusCode, 404);
});

test('POST /api/v1/activities/{activity_id}/end: 404 for others, 409 early, 200 then idempotent', async () => {
  const s = await api();
  const id = '44444444-4444-4444-8444-444444444444';
  s.db.seedActivity({ id });
  const url = `/api/v1/activities/${id}/end`;
  assert.equal((await s.app.inject({ method: 'POST', url, headers: stranger })).statusCode, 404);

  const early = await s.app.inject({ method: 'POST', url, headers: org });
  assert.equal(early.statusCode, 409);
  assert.equal(early.json().code, 'ACTIVITY_NOT_ENDED');

  s.clock.now = d('2030-05-01T10:05:00Z');
  const ok = await s.app.inject({ method: 'POST', url, headers: org });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().lifecycle, 'ENDED');
  assert.equal(ok.json().ended_at, '2030-05-01T10:05:00.000Z');
  assert.equal(s.db.outbox().length, 1);

  const again = await s.app.inject({ method: 'POST', url, headers: org });
  assert.equal(again.statusCode, 200);
  assert.equal(s.db.outbox().length, 1);
});

test('roles come from X-User-Roles: a participant cannot create an event (403)', async () => {
  const { app } = await api();
  const payload = { title: 'X', starts_at: '2031-01-01T10:00:00Z', ends_at: '2031-01-02T10:00:00Z' };
  const denied = await app.inject({ method: 'POST', url: '/api/v1/events', headers: { 'x-user-id': OTHER_ID, 'x-user-roles': 'participant' }, payload });
  assert.equal(denied.statusCode, 403);
  const created = await app.inject({ method: 'POST', url: '/api/v1/events', headers: { 'x-user-id': OTHER_ID, 'x-user-roles': ' organizer ' }, payload });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().organizer_id, OTHER_ID);
  assert.match(created.json().event_id, /^[0-9a-f-]{36}$/);
  assert.equal('id' in created.json(), false);
});

test('request bodies use amount_minor; price_cents and capacity in a patch are rejected with 400', async () => {
  const s = await api();
  const id = '44444444-4444-4444-8444-444444444444';
  s.db.seedActivity({ id });
  const patch = (payload: object) => s.app.inject({ method: 'PATCH', url: `/api/v1/activities/${id}`, headers: org, payload });
  assert.equal((await patch({ price_cents: 10 })).statusCode, 400);
  assert.equal((await patch({ capacity: 99 })).statusCode, 400);
  const ok = await patch({ speaker: 'Ana' });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().speaker, 'Ana');

  const createBody = { title: 'T', starts_at: '2030-05-01T09:00:00Z', ends_at: '2030-05-01T10:00:00Z', capacity: 5 };
  const eventId = '66666666-6666-4666-8666-666666666666';
  s.db.seedEvent({ id: eventId, status: 'DRAFT' });
  const post = (payload: object) => s.app.inject({ method: 'POST', url: `/api/v1/events/${eventId}/activities`, headers: org, payload });
  assert.equal((await post({ ...createBody, price_cents: 100 })).statusCode, 400);
  const created = await post({ ...createBody, amount_minor: 100 });
  assert.equal(created.statusCode, 201);
  assert.equal(created.json().amount_minor, 100);
  assert.equal(created.json().paid, true);
});

test('OpenAPI: /api/v1 paths with event_id/activity_id, the end and permissions routes, no bearer scheme', async () => {
  const { app } = await api();
  const spec = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
  assert.deepEqual(Object.keys(spec.paths).sort(), [
    '/api/v1/activities/{activity_id}', '/api/v1/activities/{activity_id}/end', '/api/v1/activities/{activity_id}/permissions/me',
    '/api/v1/events', '/api/v1/events/{event_id}', '/api/v1/events/{event_id}/activities', '/api/v1/events/{event_id}/cancel',
    '/api/v1/events/{event_id}/publish', '/api/v1/me/events',
  ]);
  assert.equal(spec.components?.securitySchemes, undefined);
  assert.equal(JSON.stringify(spec).includes('"security"'), false);
  assert.match(spec.info.description, /X-User-Id/);
  const activity = spec.paths['/api/v1/activities/{activity_id}'].get.responses['200'].content['application/json'].schema;
  assert.ok(activity.properties.amount_minor && activity.properties.lifecycle && activity.properties.registration_open);
  assert.equal(activity.properties.available, undefined);
});

test('openapi: every operation declares its x-gateway settings; /healthcheck stays hidden', async () => {
  const { app } = await api();
  await app.ready();
  const pub = { isPublic: true, requireAuth: true };
  const optional = { isPublic: true, requireAuth: false };
  const internal = { isPublic: false, requireAuth: false };
  const expected: Record<string, unknown> = {
    'get /api/v1/events': optional,
    'get /api/v1/events/{event_id}': optional,
    'get /api/v1/events/{event_id}/activities': optional,
    'get /api/v1/activities/{activity_id}': optional,
    'get /api/v1/me/events': pub,
    'post /api/v1/events': pub,
    'patch /api/v1/events/{event_id}': pub,
    'post /api/v1/events/{event_id}/publish': pub,
    'post /api/v1/events/{event_id}/cancel': pub,
    'post /api/v1/events/{event_id}/activities': pub,
    'patch /api/v1/activities/{activity_id}': pub,
    'post /api/v1/activities/{activity_id}/end': pub,
    'delete /api/v1/activities/{activity_id}': pub,
    'get /api/v1/activities/{activity_id}/permissions/me': internal,
  };
  const paths = app.swagger().paths as Record<string, Record<string, Record<string, unknown>>>;
  const actual: Record<string, unknown> = {};
  for (const [path, item] of Object.entries(paths)) {
    for (const [method, op] of Object.entries(item)) {
      const gw = op['x-gateway'] as Record<string, unknown>;
      assert.equal(typeof gw?.isPublic, 'boolean', `${method} ${path}`);
      assert.equal(typeof gw?.requireAuth, 'boolean', `${method} ${path}`);
      actual[`${method} ${path}`] = gw;
    }
  }
  assert.deepEqual(actual, expected);
});
