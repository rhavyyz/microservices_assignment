import test from 'node:test';
import assert from 'node:assert/strict';

const KEYS = ['PAYMENT_EVENTS_TOPIC', 'PAYMENT_COMMANDS_TOPIC', 'PAYMENTS_TOPIC', 'NOTIFICATIONS_TOPIC', 'SUBSCRIPTION_TOPIC', 'PAYMENT_TTL_SECONDS', 'PAYMENTS_CONSUMER_GROUP'];

test('defaults: topics, consumer group and payment TTL; no commands topic', async () => {
  for (const k of KEYS) delete process.env[k];
  const { config } = await import('../src/config.ts?defaults');
  assert.equal(config.paymentEventsTopic, 'payments.events');
  assert.equal(config.notificationsTopic, 'notifications');
  assert.equal(config.subscriptionTopic, 'subscription.events');
  assert.equal(config.consumerGroup, 'payments-service');
  assert.equal(config.paymentTtlSeconds, 900);
  assert.equal('discovererUrl' in config, false);
  assert.equal('serviceHost' in config, false);
  assert.equal('paymentCommandsTopic' in config, false);
});

test('env overrides; the old PAYMENTS_TOPIC and PAYMENT_COMMANDS_TOPIC are ignored', async () => {
  process.env.PAYMENT_EVENTS_TOPIC = 'x.events';
  process.env.SUBSCRIPTION_TOPIC = 'x.sub';
  process.env.PAYMENT_TTL_SECONDS = '60';
  process.env.PAYMENT_COMMANDS_TOPIC = 'x.commands';
  process.env.PAYMENTS_TOPIC = 'old';
  try {
    const { config } = await import('../src/config.ts?override');
    assert.equal(config.paymentEventsTopic, 'x.events');
    assert.equal(config.subscriptionTopic, 'x.sub');
    assert.equal(config.paymentTtlSeconds, 60);
    assert.equal('paymentCommandsTopic' in config, false);
  } finally {
    for (const k of KEYS) delete process.env[k];
  }
});

test('PAYMENT_TTL_SECONDS must be a positive integer', async () => {
  try {
    for (const [i, bad] of ['0', '-5', '1.5', 'abc'].entries()) {
      process.env.PAYMENT_TTL_SECONDS = bad;
      await assert.rejects(import(`../src/config.ts?badttl${i}`), /PAYMENT_TTL_SECONDS must be a positive integer/);
    }
  } finally {
    delete process.env.PAYMENT_TTL_SECONDS;
  }
});
