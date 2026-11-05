import test from 'node:test';
import assert from 'node:assert/strict';
import type { Log } from '../src/audit.ts';
import type { SeatCommand } from '../src/messaging/commands.ts';
import { handleRecord } from '../src/messaging/consumer.ts';
import type { SeatService } from '../src/services/seats.ts';

const where = { topic: 'subscription-events', partition: 0, offset: '42' };

function fakes(handle: SeatService['handle'] = async () => 'RESERVED') {
  const logs: { level: string; obj: object; msg: string }[] = [];
  const log: Log = {
    info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
    warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
    error: (obj, msg) => logs.push({ level: 'error', obj, msg }),
  };
  const calls: [string, string | null, SeatCommand][] = [];
  const seats: SeatService = { handle: async (id, corr, c) => { calls.push([id, corr, c]); return handle(id, corr, c); } };
  return { log, logs, seats, calls };
}

const record = (type: string) => JSON.stringify({
  message_id: 'm1', type, version: 1, occurred_at: '2030-01-01T00:00:00Z', trace_id: 'c1',
  data: { registration_id: 'r1', event_id: 'e1', activity_id: 'a1', user_id: 'u1' },
});

test('seat requests go to the seat service and the outcome is logged with the trace id', async () => {
  const f = fakes();
  await handleRecord(record('registration.requested'), where, f.seats, f.log);
  assert.deepEqual(f.calls, [['m1', 'c1', { kind: 'reserve', registrationId: 'r1', eventId: 'e1', activityId: 'a1', userId: 'u1' }]]);
  assert.deepEqual(f.logs, [{
    level: 'info', msg: 'message processed',
    obj: { ...where, type: 'registration.requested', message_id: 'm1', trace_id: 'c1', outcome: 'RESERVED' },
  }]);
});

test('other types are skipped silently; empty and malformed records are logged and skipped', async () => {
  const f = fakes();
  await handleRecord(record('checkin.registered'), where, f.seats, f.log);
  await handleRecord(undefined, where, f.seats, f.log);
  await handleRecord('{bad', where, f.seats, f.log);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.logs.map((l) => [l.level, l.msg]), [['warn', 'empty message skipped'], ['warn', 'invalid message skipped']]);
});

test('a database failure propagates so the record is redelivered', async () => {
  const f = fakes(async () => { throw new Error('db down'); });
  await assert.rejects(handleRecord(record('registration.cancelled'), where, f.seats, f.log), /db down/);
});
