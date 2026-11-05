import { after, before, beforeEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Log } from '../../src/audit.ts';
import { createOutboxRelay, type Publisher } from '../../src/messaging/relay.ts';
import type { OutboxMessage } from '../../src/repositories/outbox.ts';
import { eventInput, organizer, reset, setup, skip } from './helpers.ts';

type Env = Awaited<ReturnType<typeof setup>>;
const quiet: Log = { info: () => {}, warn: () => {}, error: () => {} };

describe('outbox relay (Transactional Outbox)', { skip }, () => {
  let env: Env;
  before(async () => { env = await setup(); });
  beforeEach(async () => { await reset(env.pool); });
  after(async () => { await env.pool.end(); });

  const relay = (publish: Publisher, batchSize = 100) =>
    createOutboxRelay({ pool: env.pool, publish, batchSize, intervalMs: 10, retentionHours: 24, log: quiet });

  async function pending(): Promise<number> {
    return (await env.pool.query('SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')).rows[0].n;
  }

  test('publishes committed messages in order and marks them published', async () => {
    const e = await env.events.createEvent(organizer, eventInput());
    await env.events.updateEvent(organizer, e.event_id, { title: 'B' });
    await env.events.cancelEvent(organizer, e.event_id);
    const sent: OutboxMessage[] = [];
    assert.equal(await relay(async (b) => { sent.push(...b); }).publishBatch(), 3);
    assert.deepEqual(sent.map((m) => m.envelope.type), ['EventCreated', 'EventUpdated', 'EventCancelled']);
    assert.ok(sent.every((m) => m.key === e.event_id && m.topic === 'events.events'));
    assert.equal(await pending(), 0);
    assert.equal(await relay(async () => { throw new Error('nothing to send'); }).publishBatch(), 0);
  });

  test('a broker failure leaves the batch pending; the next attempt sends it with the same message ids', async () => {
    await env.events.createEvent(organizer, eventInput());
    await assert.rejects(relay(async () => { throw new Error('broker down'); }).publishBatch(), /broker down/);
    assert.equal(await pending(), 1);
    const ids: string[] = [];
    await relay(async (b) => { ids.push(...b.map((m) => m.envelope.message_id)); }).publishBatch();
    const stored = (await env.pool.query('SELECT message_id FROM outbox')).rows[0].message_id;
    assert.deepEqual(ids, [stored]);
    assert.equal(await pending(), 0);
  });

  test('a rolled back change never reaches the outbox', async () => {
    await assert.rejects(env.events.createEvent(organizer, eventInput({ ends_at: new Date(0) })));
    assert.equal((await env.pool.query('SELECT count(*)::int AS n FROM outbox')).rows[0].n, 0);
  });

  test('two relays running together never publish a message twice', async () => {
    for (let i = 0; i < 30; i++) await env.events.createEvent(organizer, eventInput({ title: `E${i}` }));
    const sent: string[] = [];
    const slow: Publisher = async (b) => { await new Promise((r) => setTimeout(r, 20)); sent.push(...b.map((m) => m.envelope.message_id)); };
    const a = relay(slow, 5);
    const b = relay(slow, 5);
    while ((await pending()) > 0) await Promise.all([a.publishBatch(), b.publishBatch()]);
    assert.equal(sent.length, 30);
    assert.equal(new Set(sent).size, 30);
  });

  test('the background loop drains the outbox and stops cleanly', async () => {
    for (let i = 0; i < 7; i++) await env.events.createEvent(organizer, eventInput({ title: `E${i}` }));
    let n = 0;
    const r = relay(async (b) => { n += b.length; }, 3);
    r.start();
    for (let i = 0; i < 100 && (await pending()) > 0; i++) await new Promise((res) => setTimeout(res, 10));
    await r.stop();
    assert.equal(n, 7);
  });
});
