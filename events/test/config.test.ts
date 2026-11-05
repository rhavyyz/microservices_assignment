import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('defaults point at the compose infrastructure', () => {
  const c = loadConfig({});
  assert.equal(c.port, 8080);
  assert.equal(c.databaseUrl, 'postgres://events:events@events-db:5432/events');
  assert.deepEqual(c.kafkaBrokers, ['kafka:9092']);
  assert.equal(c.eventsTopic, 'events.events');
  assert.equal(c.activityAutoEndAfterSeconds, 86400);
});

test('the service consumes nothing and verifies no token: those settings are gone', () => {
  const c = loadConfig({ SUBSCRIPTION_TOPIC: 'x', JWT_JWKS_URL: 'http://u', EVENTS_CONSUMER_GROUP: 'g' }) as Record<string, unknown>;
  for (const k of ['subscriptionTopic', 'consumerGroup', 'jwtIssuer', 'jwksUrl', 'jwksCacheSeconds']) assert.equal(k in c, false, k);
});

test('reads and trims overrides', () => {
  const c = loadConfig({ PORT: '9000', KAFKA_BROKERS: ' a:1 , b:2 ,', EVENTS_TOPIC: ' my.topic ', ACTIVITY_AUTO_END_AFTER_SECONDS: ' 3600 ' });
  assert.equal(c.port, 9000);
  assert.deepEqual(c.kafkaBrokers, ['a:1', 'b:2']);
  assert.equal(c.eventsTopic, 'my.topic');
  assert.equal(c.activityAutoEndAfterSeconds, 3600);
});

test('invalid integers stop the service', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT must be a positive integer/);
  assert.throws(() => loadConfig({ OUTBOX_BATCH_SIZE: '0' }), /OUTBOX_BATCH_SIZE/);
});

test('ACTIVITY_AUTO_END_AFTER_SECONDS must be a positive integer', () => {
  for (const bad of ['0', '-5', '1.5', 'abc', '1h']) {
    assert.throws(() => loadConfig({ ACTIVITY_AUTO_END_AFTER_SECONDS: bad }), /ACTIVITY_AUTO_END_AFTER_SECONDS must be a positive integer/, bad);
  }
});
