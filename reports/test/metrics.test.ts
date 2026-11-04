import test from 'node:test';
import assert from 'node:assert/strict';
import { ratio } from '../src/metrics.ts';

test('ratio rounds to 4 decimals and is null without a denominator', () => {
  assert.equal(ratio(1, 3), 0.3333);
  assert.equal(ratio(5, 10), 0.5);
  assert.equal(ratio(0, 10), 0);
  assert.equal(ratio(3, 0), null);
  assert.equal(ratio(3, -1), null);
});
