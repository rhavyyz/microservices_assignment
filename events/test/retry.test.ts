import test from 'node:test';
import assert from 'node:assert/strict';
import { backoffDelay, retryForever } from '../src/retry.ts';

test('backoff doubles from 1s up to the 30s cap', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map((a) => backoffDelay(a)), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
});

test('retryForever retries with backoff until the task succeeds', async () => {
  let n = 0;
  const errors: number[] = [];
  await retryForever('task', async () => { if (++n < 3) throw new Error('down'); }, (_name, _e, delay) => errors.push(delay), async () => {});
  assert.equal(n, 3);
  assert.deepEqual(errors, [1000, 2000]);
});
