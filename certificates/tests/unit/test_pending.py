"""Messages that arrive before their event ends are parked, not retried in place (ADR-006 addendum)."""

import uuid
from datetime import timedelta, timezone

import pytest

from app.config import settings
from app.consumer import AttendanceWorker, DeadLetters, Source
from app.integrations.directory import PoisonMessage, TransientError
from app.models.pending_attendance import PendingAttendance
from app.pending import BACKOFF_MAX, PendingScheduler, backoff

from .test_consumer import (  # noqa: F401  (env is a fixture)
    EVENT_ID,
    NOW,
    REGISTRATION_ID,
    USER_ID,
    FakeKafkaConsumer,
    FakeMessage,
    FakeProducer,
    certificates,
    env,
    event,
)

SOURCE = Source("subscription.events", 3, 41)


def utc(value):
    # SQLite hands timestamps back without a zone; they are stored in UTC.
    return value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value.astimezone(timezone.utc)


def rows(factory):
    with factory() as session:
        return session.query(PendingAttendance).order_by(PendingAttendance.source_offset).all()


@pytest.fixture
def parked(env):
    """The env with the event still running and one message already parked at SOURCE."""
    handler, directory, factory, storage, clock = env
    ends_at = directory.event.ends_at
    clock["now"] = ends_at - timedelta(days=2)
    handler.handle(event(), SOURCE)
    producer = FakeProducer()
    scheduler = PendingScheduler(
        handler=handler,
        session_factory=factory,
        dead_letters=DeadLetters(lambda config: producer),
        clock=lambda: clock["now"],
    )
    return handler, directory, factory, clock, scheduler, producer


def test_early_message_is_parked_committed_and_does_not_block_the_next_one(env):
    handler, directory, factory, _, clock = env
    clock["now"] = directory.event.ends_at - timedelta(days=2)
    other_event = uuid.uuid4()
    original_get_event = directory.get_event

    def get_event(event_id, trace_id):
        found = original_get_event(event_id, trace_id)
        # The second message belongs to an event that already ended.
        return found if event_id == EVENT_ID else found.__class__(**{**found.__dict__, "ends_at": clock["now"]})

    directory.get_event = get_event
    consumer = FakeKafkaConsumer()
    worker = AttendanceWorker(handler=handler, producer_factory=lambda config: FakeProducer())
    worker.stop.wait = lambda delay: False

    worker.process(consumer, FakeMessage(event(), offset=10))
    worker.process(consumer, FakeMessage(
        event(registration_id=str(uuid.uuid4()), user_id=str(uuid.uuid4()), event_id=str(other_event)), offset=11,
    ))

    assert consumer.commits == [10, 11]
    assert consumer.seeks == []
    [row] = rows(factory)
    assert row.registration_id == REGISTRATION_ID
    assert utc(row.not_before) == directory.event.ends_at
    assert (row.source_topic, row.source_partition, row.source_offset) == ("subscription.events", 2, 10)
    assert row.attempts == 0
    assert row.payload["user_id"] == str(USER_ID)
    assert len(certificates(factory)) == 1  # the second message was processed in the same run


def test_parking_twice_keeps_one_row(parked):
    handler, _, factory, *_ = parked

    handler.handle(event(), Source("subscription.events", 3, 99))

    [row] = rows(factory)
    assert row.source_offset == 41  # the first parking wins


def test_scheduler_issues_due_row_and_deletes_it(parked):
    handler, directory, factory, clock, scheduler, producer = parked
    clock["now"] = directory.event.ends_at

    assert scheduler.tick() == 1

    [certificate] = certificates(factory)
    assert certificate.registration_id == REGISTRATION_ID
    assert rows(factory) == []
    assert producer.produced == []


def test_scheduler_leaves_a_row_that_is_not_due(parked):
    _, directory, factory, clock, scheduler, _ = parked
    clock["now"] = directory.event.ends_at - timedelta(seconds=1)
    calls = len(directory.calls)

    assert scheduler.tick() == 0

    [row] = rows(factory)
    assert utc(row.not_before) == directory.event.ends_at and row.attempts == 0
    assert len(directory.calls) == calls
    assert certificates(factory) == []


def test_still_not_ended_moves_not_before_to_the_current_end(parked):
    _, directory, factory, clock, scheduler, _ = parked
    # Due by the stored date, but Events now says the event ends a day later.
    stored_end = directory.event.ends_at
    clock["now"] = stored_end
    directory.event = directory.event.__class__(**{**directory.event.__dict__, "ends_at": stored_end + timedelta(days=1)})

    scheduler.tick()

    [row] = rows(factory)
    assert utc(row.not_before) == stored_end + timedelta(days=1)
    assert row.attempts == 0
    assert certificates(factory) == []


def test_still_not_ended_by_seconds_is_retried_after_at_least_a_minute(parked):
    _, directory, factory, clock, scheduler, _ = parked
    clock["now"] = directory.event.ends_at
    directory.event = directory.event.__class__(**{**directory.event.__dict__, "ends_at": clock["now"] + timedelta(seconds=5)})

    scheduler.tick()

    [row] = rows(factory)
    assert utc(row.not_before) == clock["now"] + timedelta(seconds=60)


def test_cancelled_event_on_the_consumer_path_is_poison_and_not_parked(env):
    handler, directory, factory, _, clock = env
    clock["now"] = directory.event.ends_at - timedelta(days=2)
    directory.event = directory.event.__class__(**{**directory.event.__dict__, "status": "CANCELLED"})
    producer = FakeProducer()
    consumer = FakeKafkaConsumer()
    worker = AttendanceWorker(handler=handler, producer_factory=lambda config: producer)

    worker.process(consumer, FakeMessage(event(), offset=5))

    assert [record[2]["reason"] for record in producer.produced] == ["EVENT_CANCELLED"]
    assert consumer.commits == [5]
    assert rows(factory) == [] and certificates(factory) == []


def test_cancelled_event_whose_end_has_passed_is_not_certified(env):
    handler, directory, factory, *_ = env  # ends_at is already in the past
    directory.event = directory.event.__class__(**{**directory.event.__dict__, "status": "CANCELLED"})

    with pytest.raises(PoisonMessage) as raised:
        handler.handle(event(), SOURCE)

    assert raised.value.reason == "EVENT_CANCELLED"
    assert certificates(factory) == [] and "user" not in directory.calls


def test_cancelled_event_found_by_the_scheduler_goes_to_the_dlq_and_deletes_the_row(parked):
    _, directory, factory, clock, scheduler, producer = parked
    clock["now"] = directory.event.ends_at
    directory.event = directory.event.__class__(**{**directory.event.__dict__, "status": "CANCELLED"})

    scheduler.tick()

    [(topic, key, record)] = producer.produced
    assert (topic, key) == (settings.certificates_dlq_topic, "subscription.events:3")
    # References only, plus the trace id the parked message was given (generated: the message had none).
    uuid.UUID(record.pop("trace_id"))
    assert record == {"source_topic": "subscription.events", "partition": 3, "offset": 41, "reason": "EVENT_CANCELLED"}
    assert rows(factory) == [] and certificates(factory) == []


def test_poison_on_a_parked_row_is_published_with_the_stored_source_offset(parked):
    _, directory, factory, clock, scheduler, producer = parked
    clock["now"] = directory.event.ends_at
    directory.errors["user"] = PoisonMessage("USER_NOT_FOUND")

    scheduler.tick()

    [(_, key, record)] = producer.produced
    assert key == "subscription.events:3"
    uuid.UUID(record.pop("trace_id"))
    assert record == {"source_topic": "subscription.events", "partition": 3, "offset": 41, "reason": "USER_NOT_FOUND"}
    assert rows(factory) == []


def test_dlq_failure_keeps_the_parked_row_with_backoff(parked):
    _, directory, factory, clock, scheduler, producer = parked
    clock["now"] = directory.event.ends_at
    directory.errors["user"] = PoisonMessage("USER_NOT_FOUND")
    producer.fail = True

    scheduler.tick()

    [row] = rows(factory)
    assert row.attempts == 1
    assert utc(row.not_before) == clock["now"] + backoff(1)


def test_transient_failure_backs_off_only_that_row(parked):
    handler, directory, factory, clock, scheduler, _ = parked
    other_user = uuid.uuid4()
    handler.handle(
        event(registration_id=str(uuid.uuid4()), user_id=str(other_user)), Source("subscription.events", 3, 42)
    )
    clock["now"] = directory.event.ends_at
    original = directory.get_participant_name

    def flaky(user_id, trace_id):
        if user_id == USER_ID:
            raise TransientError("users down")
        return original(user_id, trace_id)

    directory.get_participant_name = flaky

    assert scheduler.tick() == 2

    [failed] = rows(factory)
    assert failed.registration_id == REGISTRATION_ID
    assert failed.attempts == 1
    assert utc(failed.not_before) == clock["now"] + timedelta(seconds=60)
    assert [c.user_id for c in certificates(factory)] == [other_user]

    # Not due again right away; after the delay, the next failure doubles it.
    assert scheduler.tick() == 0
    clock["now"] += timedelta(seconds=60)
    scheduler.tick()
    [failed] = rows(factory)
    assert failed.attempts == 2
    assert utc(failed.not_before) == clock["now"] + timedelta(seconds=120)

    directory.get_participant_name = original
    clock["now"] += timedelta(seconds=120)
    scheduler.tick()
    assert rows(factory) == [] and len(certificates(factory)) == 2


def test_unexpected_error_on_a_row_is_kept_and_does_not_stop_the_batch(parked):
    _, directory, factory, clock, scheduler, _ = parked
    clock["now"] = directory.event.ends_at
    directory.errors["user"] = RuntimeError("secret")

    assert scheduler.tick() == 1

    [row] = rows(factory)
    assert row.attempts == 1


def test_backoff_is_capped_at_fifteen_minutes():
    assert [backoff(n).total_seconds() for n in (1, 2, 3, 4, 5)] == [60, 120, 240, 480, 900]
    assert backoff(10_000) == BACKOFF_MAX


def test_already_issued_certificate_deletes_the_row_without_lookups(parked):
    handler, directory, factory, clock, scheduler, _ = parked
    clock["now"] = directory.event.ends_at
    handler.handle(event())  # issued meanwhile (e.g. by a redelivery)
    calls = list(directory.calls)

    scheduler.tick()

    assert rows(factory) == []
    assert len(certificates(factory)) == 1
    assert directory.calls == calls


def test_batches_are_drained_and_the_thread_stops(parked, monkeypatch):
    handler, directory, factory, clock, scheduler, _ = parked
    monkeypatch.setattr("app.pending.BATCH_SIZE", 1)
    for offset in (42, 43):
        handler.handle(event(registration_id=str(uuid.uuid4()), user_id=str(uuid.uuid4())), Source("t", 0, offset))
    clock["now"] = directory.event.ends_at
    scheduler.interval = 0.01

    assert scheduler.drain() == 3 and rows(factory) == []

    scheduler.start()
    scheduler.close()
    assert not scheduler.thread.is_alive()


def test_parked_message_keeps_its_trace_id_until_the_scheduler_issues_it(env, caplog):
    handler, directory, factory, _, clock = env
    caplog.set_level("INFO")
    clock["now"] = directory.event.ends_at - timedelta(days=2)
    trace_id = "checkin-trace-0001"
    handler.handle(event(trace_id=trace_id), SOURCE)
    assert [r for r in caplog.messages if r.startswith("attendance_parked") and f"trace_id={trace_id}" in r]
    assert directory.trace_ids == [trace_id]
    scheduler = PendingScheduler(handler=handler, session_factory=factory, clock=lambda: clock["now"])

    clock["now"] = directory.event.ends_at
    assert scheduler.tick() == 1

    assert len(certificates(factory)) == 1
    assert set(directory.trace_ids) == {trace_id}
    assert len(directory.trace_ids) == 3  # parked attempt, then event and user lookups
    assert [r for r in caplog.messages if r.startswith("attendance_unparked") and f"trace_id={trace_id}" in r]


def test_parked_message_with_invalid_trace_id_does_not_store_it(env, caplog):
    handler, directory, factory, _, clock = env
    caplog.set_level("INFO")
    clock["now"] = directory.event.ends_at - timedelta(days=2)

    handler.handle(event(trace_id="bad id!"), SOURCE)

    [row] = rows(factory)
    assert row.payload["trace_id"] == directory.trace_ids[0]
    uuid.UUID(row.payload["trace_id"])
    assert "bad id!" not in caplog.text


def test_scheduler_failures_carry_the_trace_id(parked, caplog):
    handler, directory, factory, clock, scheduler, producer = parked
    caplog.set_level("INFO")
    with factory() as session:
        row = session.query(PendingAttendance).one()
        row.payload = {**row.payload, "trace_id": "parked-trace-0001"}
        session.commit()
    clock["now"] = directory.event.ends_at
    directory.errors["user"] = TransientError("users down")

    scheduler.tick()

    assert [r for r in caplog.messages if r.startswith("pending_transient_failure") and "trace_id=parked-trace-0001" in r]

    directory.errors["user"] = PoisonMessage("USER_NOT_FOUND")
    clock["now"] = clock["now"] + timedelta(hours=1)
    scheduler.tick()

    [(_, _, record)] = producer.produced
    assert record["trace_id"] == "parked-trace-0001"
    assert [r for r in caplog.messages if r.startswith("poison_parked_message") and "trace_id=parked-trace-0001" in r]
