import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { buildServer } from '../src/server.ts';

const fakePool = { query: async () => ({ rows: [] }) } as unknown as Pool;

test('echoes X-Trace-Id and ignores the old X-Correlation-Id', async () => {
  const app = await buildServer(fakePool);
  try {
    const traced = await app.inject({ method: 'GET', url: '/healthcheck', headers: { 'x-trace-id': 'trace-abc' } });
    assert.equal(traced.headers['x-trace-id'], 'trace-abc');
    assert.equal(traced.headers['x-correlation-id'], undefined);

    const legacy = await app.inject({ method: 'GET', url: '/healthcheck', headers: { 'x-correlation-id': 'old-id' } });
    assert.ok(legacy.headers['x-trace-id']);
    assert.notEqual(legacy.headers['x-trace-id'], 'old-id');
    assert.equal(legacy.headers['x-correlation-id'], undefined);
  } finally {
    await app.close();
  }
});
