import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.ts';

test('defaults point at the compose infrastructure', () => {
  const c = loadConfig({});
  assert.equal(c.port, 8080);
  assert.equal(c.databaseUrl, 'postgres://events:events@events-db:5432/events');
  assert.deepEqual(c.kafkaBrokers, ['kafka:9092']);
  assert.equal(c.eventsTopic, 'events-events');
  assert.equal(c.subscriptionTopic, 'subscription-events');
  assert.equal(c.jwtIssuer, 'eventhub-users');
  assert.equal(c.jwksUrl, null);
  assert.match(c.serviceHost, /:8080$/);
});

test('reads and trims overrides', () => {
  const c = loadConfig({ PORT: '9000', KAFKA_BROKERS: ' a:1 , b:2 ,', JWT_JWKS_URL: ' http://u/jwks ' });
  assert.equal(c.port, 9000);
  assert.deepEqual(c.kafkaBrokers, ['a:1', 'b:2']);
  assert.equal(c.jwksUrl, 'http://u/jwks');
  assert.match(c.serviceHost, /:9000$/);
});

test('invalid integers stop the service', () => {
  assert.throws(() => loadConfig({ PORT: 'abc' }), /PORT must be a positive integer/);
  assert.throws(() => loadConfig({ OUTBOX_BATCH_SIZE: '0' }), /OUTBOX_BATCH_SIZE/);
});
