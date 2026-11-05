import test from 'node:test';
import assert from 'node:assert/strict';
import { conflict } from '../src/errors.ts';
import { toListQuery, withDates } from '../src/http/input.ts';
import { traceIdFrom, toProblem } from '../src/http/problems.ts';

test('business errors keep their status, code and message', () => {
  const { problem, unexpected } = toProblem(conflict('EVENT_CANCELLED', 'the event is cancelled'), 'trace-123');
  assert.equal(unexpected, false);
  assert.deepEqual(problem, {
    type: 'about:blank', title: 'Conflict', status: 409, detail: 'the event is cancelled', code: 'EVENT_CANCELLED', traceId: 'trace-123',
  });
});

test('schema validation errors list the offending fields', () => {
  const err = {
    statusCode: 400, validationContext: 'body', validation: [
      { instancePath: '', message: 'must NOT have additional properties', params: { additionalProperty: 'capacity' } },
      { instancePath: '', message: "must have required property 'title'", params: { missingProperty: 'title' } },
      { instancePath: '/price_cents', message: 'must be >= 0', params: { limit: 0 } },
      { instancePath: '', message: 'must NOT have fewer than 1 properties', params: { limit: 1 } },
    ],
  };
  const { problem } = toProblem(err, 't');
  assert.equal(problem.status, 400);
  assert.equal(problem.code, 'VALIDATION_ERROR');
  assert.deepEqual(problem.errors, [
    { field: 'capacity', message: 'is not allowed' },
    { field: 'title', message: "must have required property 'title'" },
    { field: 'price_cents', message: 'must be >= 0' },
    { field: 'body', message: 'must NOT have fewer than 1 properties' },
  ]);
});

test('framework 4xx keep their message; anything else is a generic 500 to be logged', () => {
  const bad = toProblem({ statusCode: 415, message: 'Unsupported Media Type: text/plain' }, 't');
  assert.deepEqual([bad.problem.status, bad.problem.code, bad.problem.detail, bad.unexpected], [415, 'BAD_REQUEST', 'Unsupported Media Type: text/plain', false]);

  const boom = toProblem(new Error('connection to db-host:5432 refused, password=...'), 't-9');
  assert.equal(boom.unexpected, true);
  assert.equal(boom.problem.status, 500);
  assert.equal(boom.problem.code, 'INTERNAL_ERROR');
  assert.doesNotMatch(boom.problem.detail, /db-host|password/);
  assert.equal(boom.problem.traceId, 't-9');
  assert.equal(toProblem('thrown string', 't').problem.status, 500);
});

test("the gateway's trace id is kept only when it is well formed", () => {
  const gen = () => 'generated';
  assert.equal(traceIdFrom('0123456789abcdef0123456789abcdef', gen), '0123456789abcdef0123456789abcdef');
  assert.equal(traceIdFrom('short', gen), 'generated');
  assert.equal(traceIdFrom('has spaces in it', gen), 'generated');
  assert.equal(traceIdFrom('x'.repeat(65), gen), 'generated');
  assert.equal(traceIdFrom(['a', 'b'], gen), 'generated');
  assert.equal(traceIdFrom(undefined, gen), 'generated');
});

test('bodies get Date periods and keep absent fields absent', () => {
  assert.deepEqual(withDates({ title: 't', starts_at: '2030-01-01T10:00:00Z' }), { title: 't', starts_at: new Date('2030-01-01T10:00:00Z') });
  assert.deepEqual(withDates({ description: null }), { description: null });
});

test('list query: trimmed text, dates, defaults from the schema', () => {
  assert.deepEqual(toListQuery({ q: '  kafka ', from: '2030-01-01T00:00:00Z', limit: 20, offset: 40 }), {
    text: 'kafka', from: new Date('2030-01-01T00:00:00Z'), to: undefined, limit: 20, offset: 40,
  });
  assert.equal(toListQuery({ q: '   ', limit: 1, offset: 0 }).text, undefined);
});

test('the legacy X-Request-Id header is ignored: only X-Trace-Id is read', () => {
  const headers: Record<string, unknown> = { 'x-request-id': '0123456789abcdef0123456789abcdef' };
  assert.equal(traceIdFrom(headers['x-trace-id'], () => 'generated'), 'generated');
});
