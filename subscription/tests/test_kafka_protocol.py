"""Roundtrip usando o cluster mock nativo do librdkafka, sem Docker ou broker externo.

Exercita serialização e callbacks do cliente real. Não substitui teste com Kafka de produção.
"""

import json
import time
from uuid import uuid4

from confluent_kafka import Consumer, Producer
from test_service import activity, register

from app.workers import Workers


def test_outbox_real_client_roundtrip(service, db, settings):
    producer = Producer(
        {"test.mock.num.brokers": 1, "enable.idempotence": True, "acks": "all", "delivery.timeout.ms": 5000}
    )
    metadata = producer.list_topics(timeout=5)
    bootstrap = ",".join(f"{broker.host}:{broker.port}" for broker in metadata.brokers.values())
    reg = register(service, activity(amount=100))
    worker = Workers(db, service, None, settings)
    assert worker.publish_once(producer)
    consumer = Consumer(
        {
            "bootstrap.servers": bootstrap,
            "group.id": "test-" + uuid4().hex,
            "auto.offset.reset": "earliest",
            "enable.auto.commit": False,
        }
    )
    try:
        consumer.subscribe([settings.payment_commands])
        deadline = time.monotonic() + 15
        message = None
        while time.monotonic() < deadline:
            candidate = consumer.poll(0.5)
            if candidate is not None and not candidate.error():
                message = candidate
                break
        assert message is not None
        payload = json.loads(message.value())
        assert payload["type"] == "PaymentRequested"
        assert payload["registration_id"] == reg["id"]
        assert message.key().decode() == reg["id"]
        consumer.commit(message=message, asynchronous=False)
    finally:
        consumer.close()
        producer.flush(5)
