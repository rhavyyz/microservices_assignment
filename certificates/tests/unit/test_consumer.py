import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.config import settings
from app.consumer import AttendanceHandler, AttendanceWorker
from app.database import Base
from app.integrations.directory import Activity, PoisonMessage, TransientError
from app.models.certificate import Certificate
from app.services.storage import CertificateStorage, CertificateStorageError

NOW = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)
REGISTRATION_ID, ACTIVITY_ID, USER_ID, EVENT_ID = (uuid.uuid4() for _ in range(4))


def event(**overrides):
    payload = {
        "event_id": str(uuid.uuid4()),
        "schema_version": 1,
        "type": "AttendanceEligible",
        "registration_id": str(REGISTRATION_ID),
        "activity_id": str(ACTIVITY_ID),
        "user_id": str(USER_ID),
        "aggregate_version": 3,
        "occurred_at": "2026-11-04T11:00:00Z",
        "status": "ATTENDED",
    }
    payload.update(overrides)
    return json.dumps(payload).encode()


class FakeDirectory:
    def __init__(self):
        self.activity = Activity(
            id=ACTIVITY_ID,
            event_id=EVENT_ID,
            title="Workshop",
            starts_at=datetime(2026, 11, 4, 8, 0, tzinfo=timezone.utc),
            ends_at=NOW - timedelta(hours=1),
        )
        self.event_title = "Software Week"
        self.name = "Alex Example"
        self.errors = {}
        self.calls = []
        self.request_ids = []

    def _call(self, name, request_id):
        self.calls.append(name)
        self.request_ids.append(request_id)
        if name in self.errors:
            raise self.errors[name]

    def get_activity(self, activity_id, request_id):
        self._call("activity", request_id)
        return self.activity

    def get_event_title(self, event_id, request_id):
        self._call("event", request_id)
        return self.event_title

    def get_participant_name(self, user_id, request_id):
        self._call("user", request_id)
        return self.name


@pytest.fixture
def env(tmp_path):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    Base.metadata.create_all(engine)
    factory = sessionmaker(bind=engine, expire_on_commit=False)
    storage = CertificateStorage(tmp_path / "pdfs")
    directory = FakeDirectory()
    clock = {"now": NOW}
    handler = AttendanceHandler(
        directory=directory,
        session_factory=factory,
        storage_factory=lambda: storage,
        clock=lambda: clock["now"],
    )
    yield handler, directory, factory, storage, clock
    engine.dispose()


def certificates(factory):
    with factory() as session:
        return session.query(Certificate).all()


def test_success_issues_certificate_with_event_data(env, monkeypatch):
    handler, directory, factory, storage, _ = env
    captured = {}

    from app.services import certificate_service

    real = certificate_service.generate_certificate_pdf

    def spy(**kwargs):
        captured.update(kwargs)
        return real(**kwargs)

    monkeypatch.setattr(certificate_service, "generate_certificate_pdf", spy)

    handler.handle(event())

    [certificate] = certificates(factory)
    assert certificate.registration_id == REGISTRATION_ID
    assert certificate.user_id == USER_ID
    assert certificate.activity_id == ACTIVITY_ID
    assert storage.read_pdf(certificate.file_path).startswith(b"%PDF")
    assert captured["participant_name"] == "Alex Example"
    assert captured["event_name"] == "Software Week"
    assert captured["event_date"] == directory.activity.starts_at.date()
    # One X-Request-Id per message, reused on every outbound call.
    assert len(set(directory.request_ids)) == 1
    uuid.UUID(directory.request_ids[0])


def test_event_title_falls_back_to_activity_title(env, monkeypatch):
    handler, directory, factory, _, _ = env
    directory.event_title = None
    names = {}
    from app.services import certificate_service

    real = certificate_service.generate_certificate_pdf
    monkeypatch.setattr(
        certificate_service,
        "generate_certificate_pdf",
        lambda **kw: names.update(kw) or real(**kw),
    )

    handler.handle(event())

    assert names["event_name"] == "Workshop"


@pytest.mark.parametrize("kind", ["AttendanceRevoked", "SomethingNew", None, 5])
def test_other_types_are_ignored_without_lookups(env, kind):
    handler, directory, factory, _, _ = env

    handler.handle(event(type=kind, schema_version=99, user_id="garbage"))

    assert directory.calls == []
    assert certificates(factory) == []


@pytest.mark.parametrize(
    "raw, reason",
    [
        (b"{not json", "INVALID_JSON"),
        (b"\xff\xfe", "INVALID_JSON"),
        (b"", "INVALID_JSON"),
        (None, "INVALID_JSON"),
        (b"[1]", "INVALID_CONTRACT"),
        (event(schema_version=2), "UNSUPPORTED_SCHEMA_VERSION"),
        (event(schema_version=True), "UNSUPPORTED_SCHEMA_VERSION"),
        (event(schema_version=None), "UNSUPPORTED_SCHEMA_VERSION"),
        (event(registration_id="nope"), "INVALID_CONTRACT"),
        (event(activity_id=None), "INVALID_CONTRACT"),
        (event(user_id=""), "INVALID_CONTRACT"),
    ],
)
def test_malformed_events_are_poison(env, raw, reason):
    handler, directory, factory, _, _ = env

    with pytest.raises(PoisonMessage) as raised:
        handler.handle(raw)

    assert raised.value.reason == reason
    assert directory.calls == []


def test_missing_id_field_is_poison(env):
    handler, *_ = env
    payload = json.loads(event())
    del payload["user_id"]

    with pytest.raises(PoisonMessage):
        handler.handle(json.dumps(payload).encode())


@pytest.mark.parametrize("failing, reason", [("activity", "ACTIVITY_NOT_FOUND"), ("user", "USER_NOT_FOUND")])
def test_unknown_activity_or_user_is_poison(env, failing, reason):
    handler, directory, factory, _, _ = env
    directory.errors[failing] = PoisonMessage(reason)

    with pytest.raises(PoisonMessage) as raised:
        handler.handle(event())

    assert raised.value.reason == reason
    assert certificates(factory) == []


@pytest.mark.parametrize("failing", ["activity", "event", "user"])
def test_dependency_failures_are_transient(env, failing):
    handler, directory, factory, _, _ = env
    directory.errors[failing] = TransientError("down")

    with pytest.raises(TransientError):
        handler.handle(event())

    assert certificates(factory) == []


def test_activity_not_ended_is_not_issued_and_is_transient(env):
    handler, directory, factory, storage, clock = env
    clock["now"] = directory.activity.ends_at - timedelta(seconds=1)

    with pytest.raises(TransientError, match="not ended"):
        handler.handle(event())

    assert certificates(factory) == []
    assert not list(storage.storage_dir.glob("*.pdf"))
    assert "user" not in directory.calls


def test_ended_boundary_is_inclusive(env):
    handler, directory, factory, _, clock = env
    clock["now"] = directory.activity.ends_at

    handler.handle(event())

    assert len(certificates(factory)) == 1


def test_redelivered_event_is_idempotent_and_skips_lookups(env):
    handler, directory, factory, storage, _ = env

    handler.handle(event())
    calls_after_first = list(directory.calls)
    handler.handle(event(event_id=str(uuid.uuid4())))

    assert len(certificates(factory)) == 1
    assert directory.calls == calls_after_first
    assert len(list(storage.storage_dir.glob("*.pdf"))) == 1


def test_unique_violation_race_is_treated_as_success(env, monkeypatch):
    handler, directory, factory, storage, _ = env
    from app.repositories import certificate_repository

    original = certificate_repository.CertificateRepository.get_by_registration_id

    handler.handle(event())  # the "other replica" that wins the race
    # The handler's pre-check and the service's own check both miss the row, so the insert hits the unique index.
    calls = {"n": 0}

    def blind_twice(self, registration_id):
        calls["n"] += 1
        return None if calls["n"] <= 2 else original(self, registration_id)

    monkeypatch.setattr(certificate_repository.CertificateRepository, "get_by_registration_id", blind_twice)

    handler.handle(event())

    assert len(certificates(factory)) == 1
    assert len(list(storage.storage_dir.glob("*.pdf"))) == 1  # the orphan blob was cleaned up


def test_not_eligible_is_poison(env, monkeypatch):
    handler, *_ = env
    monkeypatch.setattr("app.consumer.ATTENDANCE_PERCENTAGE", 10)

    with pytest.raises(PoisonMessage) as raised:
        handler.handle(event())

    assert raised.value.reason == "NOT_ELIGIBLE"


def test_storage_failure_is_transient(env, monkeypatch):
    handler, _, factory, storage, _ = env

    def broken(pdf_bytes):
        raise CertificateStorageError("down")

    monkeypatch.setattr(storage, "save_pdf", broken)

    with pytest.raises(TransientError):
        handler.handle(event())

    assert certificates(factory) == []


def test_unexpected_error_is_transient_without_leaking_message(env):
    handler, directory, *_ = env
    directory.errors["user"] = RuntimeError("Alex Example secret")

    with pytest.raises(TransientError) as raised:
        handler.handle(event())

    assert "secret" not in str(raised.value)
    assert "Alex" not in str(raised.value)


# --- Kafka loop semantics -------------------------------------------------------------------------------------


class FakeMessage:
    def __init__(self, value, offset=7, topic="subscription.events", partition=2):
        self._value, self._offset, self._topic, self._partition = value, offset, topic, partition

    def value(self):
        return self._value

    def offset(self):
        return self._offset

    def topic(self):
        return self._topic

    def partition(self):
        return self._partition

    def error(self):
        return None


class FakeKafkaConsumer:
    def __init__(self):
        self.commits = []
        self.seeks = []

    def commit(self, message=None, asynchronous=True):
        assert asynchronous is False
        self.commits.append(message.offset())

    def seek(self, partition):
        self.seeks.append((partition.topic, partition.partition, partition.offset))


class FakeProducer:
    def __init__(self, config=None, fail=False):
        self.fail = fail
        self.produced = []

    def produce(self, topic, key, value, on_delivery):
        self.produced.append((topic, key, json.loads(value)))
        self.pending = on_delivery

    def flush(self, timeout):
        if self.fail:
            return 1
        self.pending(None, object())
        return 0


class ScriptedHandler:
    def __init__(self, outcome):
        self.outcome = outcome

    def handle(self, raw):
        if isinstance(self.outcome, Exception):
            raise self.outcome


def worker_with(outcome, producer=None):
    worker = AttendanceWorker(
        handler=ScriptedHandler(outcome),
        producer_factory=lambda config: producer or FakeProducer(),
    )
    worker.stop.wait = lambda delay: False
    return worker


def test_success_commits_after_processing():
    consumer, worker = FakeKafkaConsumer(), worker_with(None)

    worker.process(consumer, FakeMessage(b"x"))

    assert consumer.commits == [7] and consumer.seeks == []


def test_poison_publishes_reference_only_record_then_commits():
    producer = FakeProducer()
    consumer, worker = FakeKafkaConsumer(), worker_with(PoisonMessage("INVALID_JSON"), producer)

    worker.process(consumer, FakeMessage(b'{"user_id": "Alex secret"}'))

    assert producer.produced == [(
        settings.certificates_dlq_topic,
        "subscription.events:2",
        {"source_topic": "subscription.events", "partition": 2, "offset": 7, "reason": "INVALID_JSON"},
    )]
    assert consumer.commits == [7]


def test_dlq_failure_does_not_commit():
    consumer = FakeKafkaConsumer()
    worker = worker_with(PoisonMessage("INVALID_JSON"), FakeProducer(fail=True))

    worker.process(consumer, FakeMessage(b"x"))

    assert consumer.commits == []
    assert consumer.seeks == [("subscription.events", 2, 7)]


@pytest.mark.parametrize("error", [TransientError("down"), RuntimeError("boom")])
def test_transient_and_unexpected_errors_do_not_commit_and_seek_back(error):
    consumer, worker = FakeKafkaConsumer(), worker_with(error)

    worker.process(consumer, FakeMessage(b"x"))
    worker.process(consumer, FakeMessage(b"x"))

    assert consumer.commits == []
    assert consumer.seeks == [("subscription.events", 2, 7)] * 2


def test_backoff_doubles_to_30_seconds_and_resets_on_success():
    waits = []
    consumer, worker = FakeKafkaConsumer(), worker_with(TransientError("down"))
    worker.stop.wait = lambda delay: waits.append(delay) or False

    for _ in range(7):
        worker.process(consumer, FakeMessage(b"x"))
    assert waits == [2, 4, 8, 16, 30, 30, 30]

    worker.handler = ScriptedHandler(None)
    worker.process(consumer, FakeMessage(b"x"))
    assert worker.delay == 2.0


def test_loop_survives_a_failing_consumer_and_stops_cleanly(monkeypatch):
    created = []

    class Exploding:
        def __init__(self, config):
            created.append(self)
            self.closed = False

        def subscribe(self, topics):
            pass

        def poll(self, timeout):
            if len(created) == 1:
                raise RuntimeError("broker gone")
            worker.stop.set()

        def close(self):
            self.closed = True

    worker = AttendanceWorker(handler=ScriptedHandler(None), consumer_factory=Exploding, topics_ensurer=lambda *a: None)
    monkeypatch.setattr(worker.stop, "wait", lambda delay: False)

    worker.run()

    assert len(created) == 2 and all(c.closed for c in created)
