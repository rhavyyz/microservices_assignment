import test from 'node:test';
import assert from 'node:assert/strict';
import type { Log } from '../src/audit.ts';
import { createActivityAutoEnd } from '../src/jobs/auto-end.ts';
import { d, fakeService } from './fakes.ts';

const logs: { level: string; obj: object; msg: string }[] = [];
const log: Log = {
  info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
  warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
  error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
};

const HOUR = 3600;
/** Activity ending at the given hour of 2030-05-01 (the fake clock is at 12:00). */
const endingAt = (id: string, hour: number, extra = {}) =>
  ({ id, starts_at: d('2030-05-01T00:30:00Z'), ends_at: new Date(Date.UTC(2030, 4, 1, hour)), ...extra });

function setup(afterSeconds = HOUR, batchSize?: number) {
  const s = fakeService(d('2030-05-01T12:00:00Z'));
  s.db.seedEvent();
  const job = createActivityAutoEnd({ deps: s.deps, autoEndAfterSeconds: afterSeconds, log, batchSize, intervalMs: 5 });
  return { ...s, job };
}

test('ends only the activities that are due, counting the delay from the scheduled end', async () => {
  const s = setup(2 * HOUR);
  s.db.seedActivity(endingAt('due', 9));
  s.db.seedActivity(endingAt('exactly-due', 10));
  s.db.seedActivity(endingAt('not-yet', 11));
  assert.equal(await s.job.runOnce(), 2);
  assert.notEqual(s.db.activity('due').ended_at, null);
  assert.notEqual(s.db.activity('exactly-due').ended_at, null);
  assert.equal(s.db.activity('not-yet').ended_at, null);
});

test('publishes ActivityEnded once per activity, with a null trace id and no actor in the audit line', async () => {
  const s = setup();
  s.db.seedActivity(endingAt('a1', 9));
  await s.job.runOnce();
  await s.job.runOnce();
  const out = s.db.outbox();
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].type, out[0].key, out[0].activity_id, out[0].event_id, out[0].trace_id, out[0].schema_version],
    ['ActivityEnded', 'a1', 'a1', 'e1', null, 1]);
  assert.equal(out[0].ends_at, '2030-05-01T09:00:00.000Z');
  assert.deepEqual(s.audits, [{ operation: 'ACTIVITY_AUTO_END', user_id: null, trace_id: null, event_id: 'e1', activity_id: 'a1', result: 'SUCCESS' }]);
});

test('skips activities already ended, those of events that are not published, and those another replica holds', async () => {
  const s = setup();
  s.db.seedActivity(endingAt('already', 8, { ended_at: d('2030-05-01T08:30:00Z') }));
  s.db.seedActivity(endingAt('locked', 8));
  s.db.locked.add('locked');
  s.db.seedEvent({ id: 'e2', status: 'CANCELLED' });
  s.db.seedActivity(endingAt('cancelled-event', 8, { event_id: 'e2' }));
  s.db.seedEvent({ id: 'e3', status: 'DRAFT' });
  s.db.seedActivity(endingAt('draft-event', 8, { event_id: 'e3' }));
  assert.equal(await s.job.runOnce(), 0);
  assert.equal(s.db.outbox().length, 0);
  assert.equal(s.db.activity('locked').ended_at, null);
  assert.deepEqual(s.audits, []); // an idle run leaves no audit line
});

test('works through more than one batch, one transaction per batch', async () => {
  const s = setup(HOUR, 2);
  for (const id of ['a', 'b', 'c', 'd', 'e']) s.db.seedActivity(endingAt(id, 8));
  assert.equal(await s.job.runOnce(), 5);
  assert.equal(s.db.outbox().length, 5);
  assert.equal(s.audits.length, 5); // one audit line per ended activity
});

test('a run that starts while another is going is skipped (overlap guard)', async () => {
  const s = setup();
  s.db.seedActivity(endingAt('a1', 8));
  let release!: () => void;
  s.db.control.gate = new Promise<void>((r) => { release = r; });
  const first = s.job.runOnce();
  assert.equal(await s.job.runOnce(), 0);
  release();
  assert.equal(await first, 1);
  assert.equal(s.db.outbox().length, 1);
});

test('a failing run is logged, publishes nothing, and the next run works', async () => {
  const s = setup();
  s.db.seedActivity(endingAt('a1', 8));
  s.db.control.connectError = new Error('db down');
  logs.length = 0;
  assert.equal(await s.job.runOnce(), 0);
  assert.ok(logs.some((l) => l.level === 'warn' && (l.obj as { err: string }).err === 'db down'));
  assert.equal(s.db.outbox().length, 0);
  s.db.control.connectError = null;
  assert.equal(await s.job.runOnce(), 1);
});

test('start runs at once and on every interval; stop halts the timer', async () => {
  const s = setup();
  s.db.seedActivity(endingAt('a1', 8));
  s.job.start();
  s.job.start(); // idempotent
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.db.outbox().length, 1);
  s.db.seedActivity(endingAt('a2', 8));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.db.outbox().length, 2);
  await s.job.stop();
  s.db.seedActivity(endingAt('a3', 8));
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(s.db.outbox().length, 2);
});
