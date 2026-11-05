"""Criação de tópicos: idempotente, sem alterar tópicos existentes e sem bloquear o consumo/publicação."""

import threading
import time
from concurrent.futures import Future
from dataclasses import replace

import pytest
from confluent_kafka import KafkaError, KafkaException

import app.workers as module
from app.config import Settings
from app.topics import ensure_topics
from app.workers import Workers


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


def test_settings_partitions(monkeypatch):
    monkeypatch.setenv("SUBSCRIPTION_DATABASE_URL", "postgresql://x")
    monkeypatch.delenv("SUBSCRIPTION_TOPIC_PARTITIONS", raising=False)
    assert Settings.from_env().kafka_topic_partitions == 6
    monkeypatch.setenv("SUBSCRIPTION_TOPIC_PARTITIONS", "3")
    assert Settings.from_env().kafka_topic_partitions == 3
    for bad in ("0", "-1", "abc"):
        monkeypatch.setenv("SUBSCRIPTION_TOPIC_PARTITIONS", bad)
        with pytest.raises(ValueError, match="SUBSCRIPTION_TOPIC_PARTITIONS"):
            Settings.from_env()


def test_settings_attendance_min_percent(monkeypatch):
    monkeypatch.setenv("SUBSCRIPTION_DATABASE_URL", "postgresql://x")
    monkeypatch.delenv("ATTENDANCE_MIN_PERCENT", raising=False)
    assert Settings.from_env().attendance_min_percent == 75
    for good, value in (("100", 100), ("0.5", 0.5), ("80", 80)):
        monkeypatch.setenv("ATTENDANCE_MIN_PERCENT", good)
        assert Settings.from_env().attendance_min_percent == value
    for bad in ("0", "-1", "100.1", "abc", "", "nan"):
        monkeypatch.setenv("ATTENDANCE_MIN_PERCENT", bad)
        with pytest.raises(ValueError, match="ATTENDANCE_MIN_PERCENT"):
            Settings.from_env()


def test_clients_wait_for_topics_then_proceed(db, service, settings, monkeypatch):
    events = []
    attempts = []

    def fake_ensure(brokers, topics, partitions):
        attempts.append(list(topics))
        if len(attempts) < 3:
            raise RuntimeError("kafka down")
        events.append("ensured")

    class Consumer:
        def __init__(self, config):
            events.append("consumer")
            assert config["topic.metadata.refresh.interval.ms"] == 10000

        def subscribe(self, topics):
            pass

        def poll(self, timeout):
            time.sleep(0.01)

        def close(self):
            pass

    class Producer:
        def __init__(self, config):
            events.append("producer")

        def flush(self, timeout):
            return 0

    monkeypatch.setattr(module, "ensure_topics", fake_ensure)
    monkeypatch.setattr(module, "Consumer", Consumer)
    monkeypatch.setattr(module, "Producer", Producer)
    monkeypatch.setattr(Workers, "publish_once", lambda self, producer: False)
    worker = Workers(db, service, None, settings)
    waits = []
    real_wait = worker.stop.wait

    def wait(timeout=None):
        if timeout is not None and timeout >= 1:
            waits.append(timeout)
            return False
        return real_wait(timeout)

    worker.stop.wait = wait
    threads = [threading.Thread(target=t) for t in (worker.consume, worker.publish)]
    for t in threads:
        t.start()
    time.sleep(0.2)
    assert events == [] and not worker.topics_ready.is_set()
    worker.ensure()
    deadline = time.monotonic() + 5
    while len(events) < 3 and time.monotonic() < deadline:
        time.sleep(0.02)
    worker.stop.set()
    for t in threads:
        t.join(5)
    assert events[0] == "ensured"
    assert sorted(events[1:]) == ["consumer", "producer"]
    assert len(attempts) == 3 and len(set(attempts[0])) == 6
    assert waits == [2, 4]


def test_stop_during_wait_exits_promptly(db, service, settings, monkeypatch):
    def never(*args, **kwargs):
        raise AssertionError("não deve criar cliente")

    monkeypatch.setattr(module, "Consumer", never)
    monkeypatch.setattr(module, "Producer", never)
    worker = Workers(db, service, None, replace(settings))
    threads = [threading.Thread(target=t) for t in (worker.consume, worker.publish)]
    for t in threads:
        t.start()
    time.sleep(0.3)
    started = time.monotonic()
    worker.stop.set()
    for t in threads:
        t.join(3)
        assert not t.is_alive()
    assert time.monotonic() - started < 1.5
