"""Falhas na fronteira Kafka: offsets, quarentena e repetição durável."""

import json

from test_service import activity, payment, register

import app.workers as module
from app.workers import Workers


class Message:
    def __init__(self, topic, body):
        self.name, self.body = topic, body

    def topic(self):
        return self.name

    def value(self):
        return self.body

    def partition(self):
        return 0

    def offset(self):
        return 7

    def error(self):
        return None


def test_consumer_commits_only_after_business_commit(service, db, settings, monkeypatch):
    reg = register(service, activity(amount=100))
    event = payment(reg)
    worker = Workers(db, service, None, settings)
    worker.topics_ready.set()
    msg = Message(settings.payment_topic, event.model_dump_json().encode())

    class Consumer:
        def __init__(self, config):
            assert config["enable.auto.commit"] is False

        def subscribe(self, topics):
            pass

        def poll(self, timeout):
            return msg

        def commit(self, **kwargs):
            assert service.get(reg["id"])["status"] == "CONFIRMED"
            worker.stop.set()

        def close(self):
            pass

    monkeypatch.setattr(module, "Consumer", Consumer)
    worker.consume()


def test_database_failure_never_commits_offset(service, db, settings, monkeypatch):
    worker = Workers(db, service, None, settings)
    worker.topics_ready.set()
    committed = []

    class Consumer:
        def __init__(self, config):
            pass

        def subscribe(self, topics):
            pass

        def poll(self, timeout):
            return Message(settings.payment_topic, b"{}")

        def commit(self, **kwargs):
            committed.append(True)

        def close(self):
            pass

    def failure(*args):
        worker.stop.set()
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(module, "Consumer", Consumer)
    monkeypatch.setattr(worker, "process", failure)
    worker.consume()
    assert not committed


def test_quarantine_preserves_reference_without_payload(service, db, settings):
    worker = Workers(db, service, None, settings)
    worker.quarantine(Message(settings.payment_topic, b"sensitive"), "INVALID_CONTRACT")
    with db.transaction() as conn:
        payload = conn.execute("SELECT payload FROM outbox").fetchone()["payload"]
        assert payload["offset"] == 7
        assert "sensitive" not in json.dumps(payload)
