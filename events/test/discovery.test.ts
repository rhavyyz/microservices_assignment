import test from 'node:test';
import assert from 'node:assert/strict';
import { consult, register } from '../src/discovery.ts';
import { backoffDelay, retryForever } from '../src/retry.ts';

test('backoff doubles from 1s up to the 30s cap', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map((a) => backoffDelay(a)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('registers with the raw protocol and retries until it works', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const sleeps: number[] = [];
  const fetchFn = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    if (calls.length < 3) throw new Error('connection refused');
    return { status: 204 };
  }) as unknown as typeof fetch;

  await register('events', 'events-1:8080', { url: 'http://d:8080', fetchFn, sleep: async (ms) => { sleeps.push(ms); } });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0], { url: 'http://d:8080/register', body: { kind: 'events', host: 'events-1:8080' } });
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('registration gives up after 10 attempts', async () => {
  let n = 0;
  const fetchFn = (async () => { n++; return { status: 503 }; }) as unknown as typeof fetch;
  await assert.rejects(register('events', 'h', { url: 'http://d', fetchFn, sleep: async () => {} }), /could not register as events/);
  assert.equal(n, 10);
});

test('consult returns the host of a healthy instance or fails', async () => {
  const ok = (async (url: string) => {
    assert.equal(url, 'http://d/consult?kind=user');
    return { status: 200, json: async () => ({ host: 'user-1:8080' }) };
  }) as unknown as typeof fetch;
  assert.equal(await consult('user', { url: 'http://d', fetchFn: ok }), 'user-1:8080');
  const none = (async () => ({ status: 503, json: async () => ({}) })) as unknown as typeof fetch;
  await assert.rejects(consult('user', { url: 'http://d', fetchFn: none }), /no user instance/);
});

test('retryForever retries with backoff until the task succeeds', async () => {
  let n = 0;
  const errors: number[] = [];
  await retryForever('task', async () => { if (++n < 3) throw new Error('down'); }, (_name, _e, delay) => errors.push(delay), async () => {});
  assert.equal(n, 3);
  assert.deepEqual(errors, [1000, 2000]);
});
