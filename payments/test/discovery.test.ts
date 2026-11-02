import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelays, registerService } from '../src/discovery.ts';

test('backoff doubles from 1s up to the 30s cap, ~2.5 min in all', () => {
  const d = backoffDelays();
  assert.deepEqual(d, [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
  assert.equal(d.reduce((a, b) => a + b, 0), 151000);
});

test('registers with the raw protocol and retries until it works', async () => {
  const calls: { url: string; body: unknown }[] = [];
  const sleeps: number[] = [];
  let n = 0;
  const fetchFn = (async (url: string, init: { body: string }) => {
    calls.push({ url, body: JSON.parse(init.body) });
    n++;
    if (n < 3) throw new Error('connection refused');
    return { status: 204 };
  }) as unknown as typeof fetch;

  await registerService('payments', { url: 'http://d:8080', host: 'payments-1:8080', fetchFn, sleep: async (ms) => { sleeps.push(ms); } });

  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, 'http://d:8080/register');
  assert.deepEqual(calls[0].body, { kind: 'payments', host: 'payments-1:8080' });
  assert.deepEqual(sleeps, [1000, 2000]);
});

test('gives up after 10 attempts', async () => {
  let n = 0;
  const fetchFn = (async () => { n++; return { status: 503 }; }) as unknown as typeof fetch;
  await assert.rejects(
    registerService('payments', { url: 'http://d', host: 'h', fetchFn, sleep: async () => {} }),
    /could not register as payments/,
  );
  assert.equal(n, 10);
});
