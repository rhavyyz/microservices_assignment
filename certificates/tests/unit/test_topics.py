"""Topic creation: idempotent, never alters existing topics, never blocks boot (mirrors Subscription's tests)."""

from concurrent.futures import Future

import pytest
from confluent_kafka import KafkaError, KafkaException

from app.config import Settings, settings
from app.consumer import AttendanceWorker
from app.integrations.topics import ensure_topics


class FakeAdmin:
    def __init__(self, existing=(), fail=None):
        self.partitions = {name: 3 for name in existing}
        self.fail = fail
        self.calls = []

    def create_topics(self, new_topics, **kwargs):
        self.calls.append([t.topic for t in new_topics])
        out = {}
        for topic in new_topics:
            future = Future()
            if self.fail is not None:
                future.set_exception(KafkaException(KafkaError(self.fail)))
            elif topic.topic in self.partitions:
                future.set_exception(KafkaException(KafkaError(KafkaError.TOPIC_ALREADY_EXISTS)))
            else:
                assert topic.replication_factor == 1
                self.partitions[topic.topic] = topic.num_partitions
                future.set_result(None)
            out[topic.topic] = future
        return out


def test_creates_missing_topics_deduped_with_partitions():
    admin = FakeAdmin()
    ensure_topics("b:9092", ["a", "b", "a"], 6, admin_factory=lambda config: admin)
    assert admin.calls == [["a", "b"]]
    assert admin.partitions == {"a": 6, "b": 6}


def test_existing_topic_is_success_and_untouched():
    admin = FakeAdmin(existing=["a"])
    ensure_topics("b:9092", ["a", "b"], 6, admin_factory=lambda config: admin)
    assert admin.partitions == {"a": 3, "b": 6}


def test_other_error_raises():
    admin = FakeAdmin(fail=KafkaError.TOPIC_AUTHORIZATION_FAILED)
    with pytest.raises(KafkaException):
        ensure_topics("b:9092", ["a"], 6, admin_factory=lambda config: admin)


def test_settings_defaults_and_partition_validation(monkeypatch):
    for name in ("KAFKA_BROKERS", "SUBSCRIPTION_EVENTS_TOPIC", "CERTIFICATES_TOPIC_PARTITIONS", "CERTIFICATES_DLQ_TOPIC"):
        monkeypatch.delenv(name, raising=False)
    defaults = Settings()
    assert defaults.kafka_brokers == "kafka:9092"
    assert defaults.subscription_events_topic == "subscription.events"
    assert defaults.certificates_dlq_topic == "certificates.dlq"
    assert defaults.certificates_topic_partitions == 6

    monkeypatch.setenv("CERTIFICATES_TOPIC_PARTITIONS", "0")
    with pytest.raises(ValueError):
        Settings()


def test_worker_ensures_both_topics_with_backoff_until_kafka_is_up(monkeypatch):
    attempts = []

    def flaky(brokers, topics, partitions):
        attempts.append((brokers, list(topics), partitions))
        if len(attempts) < 3:
            raise RuntimeError("kafka down")

    worker = AttendanceWorker(handler=object(), topics_ensurer=flaky)
    monkeypatch.setattr(worker.stop, "wait", lambda delay: False)

    assert worker.ensure() is True
    assert len(attempts) == 3
    assert attempts[-1] == (
        settings.kafka_brokers,
        [settings.subscription_events_topic, settings.certificates_dlq_topic],
        settings.certificates_topic_partitions,
    )


def test_worker_stops_ensuring_when_asked(monkeypatch):
    worker = AttendanceWorker(handler=object(), topics_ensurer=lambda *a: (_ for _ in ()).throw(RuntimeError("down")))
    monkeypatch.setattr(worker.stop, "wait", lambda delay: worker.stop.set())

    assert worker.ensure() is False


def test_consumer_waits_for_topics_and_uses_metadata_refresh(monkeypatch):
    order = []
    configs = []

    class FakeConsumer:
        def __init__(self, config):
            configs.append(config)
            order.append("consumer")

        def subscribe(self, topics):
            order.append(("subscribe", topics))

        def poll(self, timeout):
            worker.stop.set()

        def close(self):
            order.append("close")

    worker = AttendanceWorker(
        handler=object(),
        consumer_factory=FakeConsumer,
        topics_ensurer=lambda *a: order.append("ensured"),
    )
    worker.run()

    assert order[0] == "ensured"
    assert order[1] == "consumer"
    assert ("subscribe", [settings.subscription_events_topic]) in order
    config = configs[0]
    assert config["group.id"] == "certificates-service"
    assert config["enable.auto.commit"] is False
    assert config["topic.metadata.refresh.interval.ms"] == 10000
