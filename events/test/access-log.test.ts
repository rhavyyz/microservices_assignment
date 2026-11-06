import test from 'node:test';
import assert from 'node:assert/strict';
import { registerRoutes } from '../src/http/routes.ts';
import { buildServer } from '../src/http/server.ts';
import { d, fakeService } from './fakes.ts';

const USER = '11111111-1111-4111-8111-111111111111';

/** Builds the app logging to memory; `lines()` are the JSON records written so far. */
async function logged() {
  const chunks: string[] = [];
  const stream = { write: (s: string) => void chunks.push(s) };
  const app = await (async () => {
    const s = fakeService(d('2030-05-01T08:30:00Z'));
    const app = await buildServer({ pool: s.db.pool, isReady: () => true, logger: { level: 'info', stream } });
    registerRoutes(app, { events: s.events });
    return app;
  })();
  const lines = () => chunks.join('').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  const completed = () => lines().filter((l) => l.msg === 'request completed');
  return { app, lines, completed, chunks };
}

test('access log: one completion record per request with method, path, status, responseTime and traceId', async () => {
  const { app, lines, completed } = await logged();
  const res = await app.inject({ method: 'GET', url: '/api/v1/events', headers: { 'x-trace-id': 'trace-abc-123' } });
  const [rec, ...rest] = completed();
  assert.equal(rest.length, 0);
  assert.equal(lines().filter((l) => l.msg === 'incoming request').length, 0);
  assert.equal(rec.req.method, 'GET');
  assert.equal(rec.res.statusCode, res.statusCode);
  assert.equal(typeof rec.responseTime, 'number');
  assert.equal(rec.traceId, 'trace-abc-123');
  assert.equal(rec.reqId, undefined);
  assert.equal(rec.userId, undefined);
  for (const l of lines()) assert.equal(l.traceId, 'trace-abc-123');
  await app.close();
});

test('access log: an invalid X-Trace-Id is replaced by a fresh id', async () => {
  const { app, completed } = await logged();
  const res = await app.inject({ method: 'GET', url: '/api/v1/events', headers: { 'x-trace-id': 'bad id\twith spaces' } });
  const [rec] = completed();
  assert.notEqual(rec.traceId, 'bad id\twith spaces');
  assert.equal(rec.traceId, res.headers['x-trace-id']);
  await app.close();
});

test('access log: the path is logged without the query string', async () => {
  const { app, chunks, completed } = await logged();
  await app.inject({ method: 'GET', url: '/api/v1/events' + '?q=secret-free-text&email=a%40b.com' });
  const [rec] = completed();
  assert.equal(rec.req.url, '/api/v1/events');
  assert.ok(!chunks.join('').includes('secret-free-text'));
  assert.ok(!chunks.join('').includes('a%40b.com'));
  await app.close();
});

test('access log: userId is bound only for a valid UUID X-User-Id; forged values are never logged raw', async () => {
  const { app, chunks, completed } = await logged();
  await app.inject({ method: 'GET', url: '/api/v1/events', headers: { 'x-user-id': USER } });
  await app.inject({ method: 'GET', url: '/api/v1/events', headers: { 'x-user-id': 'x fake-user' } });
  await app.inject({ method: 'GET', url: '/api/v1/events', headers: { 'x-user-id': 'x\nfake' } });
  const recs = completed();
  assert.equal(recs.length, 3);
  assert.equal(recs[0].userId, USER);
  assert.equal(recs[1].userId, undefined);
  assert.equal(recs[2].userId, undefined);
  assert.ok(!chunks.join('').includes('fake'));
  await app.close();
});

test('access log: /healthcheck is not logged', async () => {
  const { app, chunks } = await logged();
  await app.inject({ method: 'GET', url: '/healthcheck' });
  assert.equal(chunks.length, 0);
  await app.close();
});

test('access log: a 404 and a 4xx are logged with their status; the user id is on them', async () => {
  const { app, completed } = await logged();
  const missing = await app.inject({ method: 'GET', url: '/no/such/route?x=1', headers: { 'x-user-id': USER } });
  const rejected = await app.inject({ method: 'POST', url: '/api/v1/events', payload: {} });
  const [a, b, ...rest] = completed();
  assert.equal(rest.length, 0);
  assert.equal(missing.statusCode, 404);
  assert.equal(a.res.statusCode, 404);
  assert.equal(a.req.url, '/no/such/route');
  assert.equal(a.userId, USER);
  assert.equal(rejected.statusCode, 401);
  assert.equal(b.res.statusCode, 401);
  await app.close();
});
