import test from 'node:test';
import assert from 'node:assert/strict';
import type { Pool } from 'pg';
import { config } from '../src/config.ts';
import { handleMessage } from '../src/consumer.ts';
import { dlqPublisher, ensureTopics, type DeadLetter } from '../src/kafka.ts';

const where = { topic: 'payments.events', partition: 3, offset: '42' };
const log = { info: () => {}, warn: () => {} };

/** A pool whose transactions succeed; `queries` records the SQL it saw. */
function fakePool(queries: string[] = []): Pool {
  const client = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rowCount: 1, rows: [] };
    },
    release: () => {},
  };
  return { connect: async () => client } as unknown as Pool;
}

function setup() {
  const sent: DeadLetter[] = [];
  const queries: string[] = [];
  return { sent, queries, pool: fakePool(queries), publish: async (ref: DeadLetter) => void sent.push(ref) };
}

const valid = (extra: object = {}) =>
  JSON.stringify({ message_id: 'm1', schema_version: 1, type: 'RegistrationConfirmed', occurred_at: '2026-10-31T12:00:00Z',
    registration_id: 'r1', event_id: 'e1', activity_id: 'a1', ...extra });

test('invalid messages go to the DLQ as a reference only: topic, partition, offset, reason', async () => {
  const cases: Array<[string | undefined, string]> = [
    ['not json {', 'invalid JSON'],
    [undefined, 'empty message'],
    ['[]', 'message must be a JSON object'],
    [valid({ registration_id: undefined }), 'RegistrationConfirmed: registration_id is required'],
    [valid({ schema_version: 2 }), 'unsupported schema_version 2 for RegistrationConfirmed'],
  ];
  for (const [raw, reason] of cases) {
    const { sent, queries, pool, publish } = setup();
    const result = await handleMessage(pool, raw, where, log, publish);
    assert.equal(result, 'invalid');
    assert.deepEqual(sent, [{ source_topic: 'payments.events', partition: 3, offset: 42, reason }]);
    assert.deepEqual(Object.keys(sent[0]).sort(), ['offset', 'partition', 'reason', 'source_topic']);
    assert.equal(queries.length, 0, 'an invalid message does not touch the database');
  }
});

test('the DLQ record never carries the payload', async () => {
  const { sent, pool, publish } = setup();
  await handleMessage(pool, valid({ registration_id: undefined, user_id: 'secret-user-value' }), where, log, publish);
  assert.ok(!JSON.stringify(sent).includes('secret-user-value'));
});

test('a very long reason is truncated', async () => {
  const { sent, pool, publish } = setup();
  await handleMessage(pool, JSON.stringify({ message_id: 'm', type: 'T'.repeat(500), occurred_at: 'nope' }), where, log, publish);
  assert.ok(sent[0].reason.length <= 200);
});

test('when the DLQ publish fails the handler throws (offset not committed) instead of losing the reference', async () => {
  const { queries, pool } = setup();
  const failing = async () => { throw new Error('kafka down'); };
  await assert.rejects(handleMessage(pool, 'not json', where, log, failing), /kafka down/);
  assert.equal(queries.length, 0);
});

test('unknown and ignored types are not dead-lettered', async () => {
  for (const type of ['CertificateIssued', 'SomethingNew']) {
    const { sent, pool, publish } = setup();
    const result = await handleMessage(pool, valid({ type }), where, log, publish);
    assert.equal(result, 'applied');
    assert.deepEqual(sent, []);
  }
});

test('a valid message is processed and not dead-lettered; a database error throws', async () => {
  const ok = setup();
  assert.equal(await handleMessage(ok.pool, valid(), where, log, ok.publish), 'applied');
  assert.deepEqual(ok.sent, []);
  assert.ok(ok.queries.some((q) => q.includes('INSERT INTO registrations')));

  const broken = { connect: async () => ({ query: async () => { throw new Error('db down'); }, release: () => {} }) } as unknown as Pool;
  await assert.rejects(handleMessage(broken, valid(), where, log, ok.publish), /db down/);
  assert.deepEqual(ok.sent, []);
});

test('dlqPublisher sends the reference to the DLQ topic keyed by source topic:partition; fails without a producer', async () => {
  const sends: Array<{ topic: string; messages: Array<{ key: string; value: string }> }> = [];
  const producer = { send: async (r: (typeof sends)[number]) => void sends.push(r) } as never;
  const ref = { source_topic: 'events.events', partition: 1, offset: 9, reason: 'invalid JSON' };
  await dlqPublisher(() => producer)(ref);
  assert.equal(sends[0].topic, config.dlqTopic);
  assert.equal(sends[0].topic, 'reports.dlq');
  assert.equal(sends[0].messages[0].key, 'events.events:1');
  assert.deepEqual(JSON.parse(sends[0].messages[0].value), ref);

  await assert.rejects(dlqPublisher(() => undefined)(ref), /dlq producer not ready/);
});

test('ensureTopics creates the three input topics and the DLQ with the configured partitions', async () => {
  let created: Array<{ topic: string; numPartitions: number; replicationFactor: number }> = [];
  const steps: string[] = [];
  await ensureTopics({
    connect: async () => void steps.push('connect'),
    createTopics: async (o: { topics: typeof created }) => { created = o.topics; return true; },
    disconnect: async () => void steps.push('disconnect'),
  } as never);
  assert.deepEqual(created.map((t) => t.topic), [...config.topics, 'reports.dlq']);
  assert.ok(created.every((t) => t.numPartitions === config.topicPartitions && t.replicationFactor === 1));
  assert.deepEqual(steps, ['connect', 'disconnect']);
});
