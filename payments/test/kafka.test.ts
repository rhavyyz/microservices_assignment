import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.ts';
import { ensureTopics } from '../src/kafka.ts';

test('ensureTopics creates events, notifications and subscription topics (no commands topic) and disconnects', async () => {
  const calls: string[] = [];
  let created: any;
  const admin = {
    connect: async () => { calls.push('connect'); },
    createTopics: async (o: any) => { calls.push('create'); created = o; return true; },
    disconnect: async () => { calls.push('disconnect'); },
  };
  await ensureTopics(admin);
  assert.deepEqual(calls, ['connect', 'create', 'disconnect']);
  assert.deepEqual(created.topics.map((t: any) => t.topic), [config.paymentEventsTopic, config.notificationsTopic, config.subscriptionTopic]);
  assert.ok(created.topics.some((t: any) => t.topic === 'subscription.events'));
  assert.ok(!created.topics.some((t: any) => t.topic === 'payments.commands'));
  for (const t of created.topics) {
    assert.equal(t.replicationFactor, 1);
    assert.equal(t.numPartitions, config.topicPartitions);
  }
});
