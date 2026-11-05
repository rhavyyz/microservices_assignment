"""Contrato com Eventos: campos extras ignorados e tipos não tratados de events.events pulados (offline)."""

import json
from types import SimpleNamespace
from uuid import uuid4

import pytest
from pydantic import ValidationError
from test_service import activity

import app.workers as module
from app.contracts import Activity
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


def events_worker(received):
    act = activity()
    service = SimpleNamespace(activity_event=lambda event, a: received.append((event, a)))
    services = SimpleNamespace(activity=lambda activity_id: act)
    settings = SimpleNamespace(events_topic="events.events", payment_topic="payments.events", brokers="x")
    return Workers(None, service, services, settings)


def events_message(kind, **extra):
    return {
        "message_id": str(uuid4()),
        "schema_version": 1,
        "type": kind,
        "occurred_at": "2026-01-01T00:00:00Z",
        "trace_id": "t",
        "activity_id": str(uuid4()),
        "event_id": str(uuid4()),
        **extra,
    }


def without(kind, key):
    return {k: v for k, v in events_message(kind).items() if k != key}


def test_activity_model_ignores_extra_fields():
    base = activity().model_dump(mode="json")
    parsed = Activity.model_validate({**base, "title": "x", "lifecycle": "ACTIVE", "paid": False})
    assert parsed.activity_id and "title" not in parsed.model_dump()


def test_activity_model_still_requires_its_fields():
    base = activity().model_dump(mode="json")
    del base["capacity"]
    with pytest.raises(ValidationError):
        Activity.model_validate({**base, "title": "x"})


def test_unhandled_events_types_are_skipped():
    received = []
    worker = events_worker(received)
    for kind in (
        "EventCreated",
        "EventUpdated",
        "EventPublished",
        "EventCancelled",
        "ActivityCreated",
        "ActivityUpdated",
        "ActivityDeleted",
        "Anything",
    ):
        worker.process("events.events", events_message(kind))
    worker.process("events.events", without("EventCreated", "activity_id"))
    assert received == []


def test_handled_events_types_are_processed_ignoring_extras():
    received = []
    worker = events_worker(received)
    for kind in ("ActivityEnded", "ActivityCancelled"):
        worker.process("events.events", events_message(kind, ends_at="2026-01-01T00:00:00Z", other=1))
    assert [e.type for e, _ in received] == ["ActivityEnded", "ActivityCancelled"]


def test_invalid_events_messages_still_raise_for_quarantine():
    worker = events_worker([])
    bad = [
        {**events_message("ActivityEnded"), "schema_version": 2},
        {**events_message("EventCreated"), "schema_version": 2},
        {**events_message("ActivityEnded"), "message_id": "nope"},
        without("ActivityEnded", "message_id"),
        without("ActivityEnded", "type"),
        without("ActivityEnded", "activity_id"),
        {**events_message("ActivityCancelled"), "activity_id": "nope"},
    ]
    for payload in bad:
        with pytest.raises(ValidationError):
            worker.process("events.events", payload)


def run_consume(monkeypatch, body):
    worker = events_worker([])
    worker.topics_ready.set()
    quarantined, committed = [], []
    worker.quarantine = lambda message, reason: quarantined.append(reason)
    msg = Message("events.events", body)

    class Consumer:
        def __init__(self, config):
            pass

        def subscribe(self, topics):
            pass

        def poll(self, timeout):
            return msg

        def commit(self, **kwargs):
            committed.append(True)
            worker.stop.set()

        def close(self):
            pass

    monkeypatch.setattr(module, "Consumer", Consumer)
    worker.consume()
    return committed, quarantined


def test_consume_commits_skipped_message_without_dlq(monkeypatch):
    committed, quarantined = run_consume(monkeypatch, json.dumps(events_message("EventUpdated")).encode())
    assert committed == [True] and quarantined == []


def test_consume_quarantines_invalid_handled_message(monkeypatch):
    committed, quarantined = run_consume(monkeypatch, json.dumps(without("ActivityEnded", "activity_id")).encode())
    assert committed == [True] and quarantined == ["INVALID_CONTRACT"]
    committed, quarantined = run_consume(monkeypatch, b"not json")
    assert committed == [True] and quarantined == ["INVALID_CONTRACT"]
