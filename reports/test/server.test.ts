import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildServer } from '../src/server.ts';

const fakePool = { query: async () => ({ rows: [] }) } as unknown as Pool;
const USER = '11111111-1111-4111-8111-111111111111';
const EVENT = '22222222-2222-4222-8222-222222222222';

async function withApp(fn: (app: Awaited<ReturnType<typeof buildServer>>) => Promise<void>, pool: Pool = fakePool, migrated?: () => boolean) {
  const app = await buildServer(pool, migrated);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test('echoes a valid X-Trace-Id and ignores the old X-Request-Id / X-Correlation-Id', async () => {
  await withApp(async (app) => {
    const traced = await app.inject({ method: 'GET', url: '/healthcheck', headers: { 'x-trace-id': 'trace-abc' } });
    assert.equal(traced.headers['x-trace-id'], 'trace-abc');
    assert.equal(traced.headers['x-correlation-id'], undefined);

    const legacy = await app.inject({ method: 'GET', url: '/healthcheck', headers: { 'x-correlation-id': 'old-id' } });
    assert.ok(legacy.headers['x-trace-id']);
    assert.notEqual(legacy.headers['x-trace-id'], 'old-id');
    assert.equal(legacy.headers['x-correlation-id'], undefined);

    const request = await app.inject({ method: 'GET', url: '/healthcheck', headers: { 'x-request-id': 'request-id-123' } });
    assert.notEqual(request.headers['x-trace-id'], 'request-id-123');
    assert.match(String(request.headers['x-trace-id']), /^[0-9a-f-]{36}$/);
  });
});

test('trace id: too short, too long or bad characters are replaced by a generated UUID', async () => {
  await withApp(async (app) => {
    for (const bad of ['short', 'x'.repeat(65), 'has space in it', 'bad/char*here']) {
      const res = await app.inject({ method: 'GET', url: '/healthcheck', headers: { 'x-trace-id': bad } });
      const echoed = String(res.headers['x-trace-id']);
      assert.notEqual(echoed, bad, bad);
      assert.match(echoed, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, bad);
    }
    for (const good of ['abcdefgh', 'x'.repeat(64), 'a.b_c-d.1234']) {
      const res = await app.inject({ method: 'GET', url: '/healthcheck', headers: { 'x-trace-id': good } });
      assert.equal(res.headers['x-trace-id'], good);
    }
  });
});

test('traceId in an error body is the one echoed in the header', async () => {
  await withApp(async (app) => {
    const res = await app.inject({ method: 'GET', url: '/events', headers: { 'x-trace-id': 'trace-from-gw-1' } });
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers['x-trace-id'], 'trace-from-gw-1');
    assert.equal(res.json().traceId, 'trace-from-gw-1');
  });
});

test('healthcheck: 503 until the first migration, 200 after, 503 when the ping fails; body keeps {status}', async () => {
  let migrated = false;
  await withApp(async (app) => {
    const before = await app.inject({ method: 'GET', url: '/healthcheck' });
    assert.equal(before.statusCode, 503);
    assert.deepEqual(before.json(), { status: 'unavailable' });
    assert.match(String(before.headers['content-type']), /application\/json/);
    migrated = true;
    const after = await app.inject({ method: 'GET', url: '/healthcheck' });
    assert.equal(after.statusCode, 200);
    assert.deepEqual(after.json(), { status: 'ok' });
  }, fakePool, () => migrated);

  const down = { query: async () => { throw new Error('connection refused'); } } as unknown as Pool;
  await withApp(async (app) => {
    const res = await app.inject({ method: 'GET', url: '/healthcheck' });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { status: 'unavailable' });
  }, down, () => true);
});

test('unknown route: 404 NOT_FOUND as problem+json', async () => {
  await withApp(async (app) => {
    const res = await app.inject({ method: 'GET', url: '/nope' });
    assert.equal(res.statusCode, 404);
    assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
    const { traceId, ...rest } = res.json();
    assert.deepEqual(rest, { title: 'Not Found', status: 404, code: 'NOT_FOUND', detail: 'route not found' });
    assert.equal(traceId, res.headers['x-trace-id']);
  });
});

test('unexpected failure: 500 INTERNAL_ERROR without internals', async () => {
  const broken = { query: async () => { throw new Error('secret connection string postgres://u:p@host'); } } as unknown as Pool;
  await withApp(async (app) => {
    const res = await app.inject({ method: 'GET', url: `/events/${EVENT}/summary`, headers: { 'x-user-id': USER } });
    assert.equal(res.statusCode, 500);
    assert.match(String(res.headers['content-type']), /^application\/problem\+json/);
    const body = res.json();
    assert.equal(body.code, 'INTERNAL_ERROR');
    assert.equal(body.title, 'Internal Server Error');
    assert.equal(body.detail, undefined);
    assert.ok(!res.body.includes('secret'));
  }, broken);
});

test('openapi: x-gateway on every business route, not on /healthcheck nor /openapi.json', async () => {
  await withApp(async (app) => {
    const res = await app.inject({ method: 'GET', url: '/openapi.json' });
    assert.equal(res.statusCode, 200);
    const paths = res.json().paths as Record<string, Record<string, Record<string, unknown>>>;
    assert.deepEqual(Object.keys(paths).sort(), [
      '/events',
      '/events/{eventId}/activities',
      '/events/{eventId}/attendance',
      '/events/{eventId}/payments',
      '/events/{eventId}/registrations',
      '/events/{eventId}/summary',
      '/healthcheck',
    ]);
    for (const [path, item] of Object.entries(paths)) {
      const op = item.get;
      if (path === '/healthcheck') {
        assert.equal('x-gateway' in op, false);
        continue;
      }
      assert.deepEqual(op['x-gateway'], { isPublic: true, requireAuth: true, rateLimitBy: 'user_or_ip', maxPerMin: 60 }, path);
    }
  });
});

test('openapi: error responses use the problem schema and the X-User-Id requirement is documented', async () => {
  await withApp(async (app) => {
    const doc = (await app.inject({ method: 'GET', url: '/openapi.json' })).json();
    assert.deepEqual(doc.components.securitySchemes.userId, {
      type: 'apiKey', in: 'header', name: 'X-User-Id',
      description: doc.components.securitySchemes.userId.description,
    });
    for (const path of Object.keys(doc.paths).filter((p) => p !== '/healthcheck')) {
      const op = doc.paths[path].get;
      assert.deepEqual(op.security, [{ userId: [] }], path);
      for (const code of ['401', '500', ...(path === '/events' ? [] : ['404'])]) {
        const schema = op.responses[code]?.content?.['application/problem+json']?.schema;
        assert.deepEqual(schema?.required, ['title', 'status', 'code', 'traceId'], `${path} ${code}`);
      }
    }
    assert.ok(doc.paths['/events'].get.responses['400'].content['application/problem+json']);
    assert.ok(doc.paths['/events/{eventId}/activities'].get.responses['400'].content['application/problem+json']);
    assert.ok(doc.paths['/events/{eventId}/summary'].get.responses['404'].content['application/problem+json']);
  });
});
