"""Cenários RN01–RN06, incluindo disputas reais entre conexões PostgreSQL."""

from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import psycopg
import pytest

from app.contracts import Activity, ActivityEvent, DomainError, PaymentEvent
from app.service import SubscriptionService
from app.workers import Workers


def activity(capacity=1, amount=0):
    now = datetime.now(timezone.utc)
    return Activity(
        activity_id=uuid4(),
        event_id=uuid4(),
        capacity=capacity,
        amount_minor=amount,
        currency="BRL",
        registration_open=True,
        waitlist_enabled=True,
        starts_at=now + timedelta(days=1),
        ends_at=now + timedelta(days=2),
    )


def register(service, act, user=None, key=None):
    return service.create(user or uuid4(), key or str(uuid4()), act)


def payment(service, reg, kind="PaymentApproved", version=1, event_id=None):
    current = service.get(reg["id"])
    return PaymentEvent(
        event_id=event_id or uuid4(),
        schema_version=1,
        type=kind,
        registration_id=reg["id"],
        payment_attempt_id=current["payment"]["id"],
        provider_version=version,
        amount_minor=reg["amount_minor"],
        currency=reg["currency"],
    )


def invariant(db, aid):
    with db.transaction() as conn:
        row = conn.execute("SELECT * FROM activity_inventory WHERE activity_id=%s", (aid,)).fetchone()
        counts = conn.execute(
            "SELECT count(*) FILTER (WHERE status IN ('OFFERED','PENDING_PAYMENT')) AS held, "
            "count(*) FILTER (WHERE status='CONFIRMED') AS confirmed FROM registrations "
            "WHERE activity_id=%s",
            (aid,),
        ).fetchone()
        assert row["reserved"] == counts["held"]
        assert row["confirmed"] == counts["confirmed"]
        assert row["reserved"] + row["confirmed"] <= row["capacity"]
        return row


def overdue(db, reg):
    with db.transaction() as conn:
        conn.execute(
            "UPDATE registrations SET expires_at=clock_timestamp()-interval '1 second' WHERE id=%s",
            (reg["id"],),
        )


@pytest.mark.parametrize("amount", [0, 1500])
def test_hundred_concurrent_requests_ten_seats(service, db, settings, amount):
    act = activity(capacity=10, amount=amount)
    # Duas instâncias lógicas compartilham apenas o banco, como duas réplicas.
    replica = SubscriptionService(db, settings)
    with ThreadPoolExecutor(max_workers=20) as pool:
        results = list(pool.map(lambda n: register(service if n % 2 else replica, act), range(100)))
    held_state = "PENDING_PAYMENT" if amount else "CONFIRMED"
    assert sum(r["status"] == held_state for r in results) == 10
    assert sum(r["status"] == "WAITLISTED" for r in results) == 90
    invariant(db, act.activity_id)


def test_idempotent_concurrent_requests(service, db):
    act, user = activity(), uuid4()
    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(lambda _: register(service, act, user, "same-key"), range(20)))
    assert len({r["id"] for r in results}) == 1
    assert invariant(db, act.activity_id)["confirmed"] == 1
    with pytest.raises(DomainError, match="IDEMPOTENCY_CONFLICT"):
        service.create(user, "same-key", activity())


def test_different_keys_cannot_duplicate_participant(service, db):
    act, user = activity(10), uuid4()
    register(service, act, user)
    with pytest.raises(DomainError, match="ALREADY_REGISTERED"):
        register(service, act, user)
    assert invariant(db, act.activity_id)["confirmed"] == 1


def test_payment_confirmation_duplicate_and_stale(service, db):
    act = activity(amount=100)
    reg = register(service, act)
    event = payment(service, reg, version=2)
    service.payment_event(event)
    service.payment_event(event)
    service.payment_event(payment(service, reg, "PaymentDeclined", version=1))
    assert service.get(reg["id"])["status"] == "CONFIRMED"
    assert invariant(db, act.activity_id)["confirmed"] == 1


@pytest.mark.parametrize("kind", ["PaymentDeclined", "PaymentExpired", "PaymentCancelled"])
def test_financial_failure_releases_seat(service, db, kind):
    act = activity(amount=100)
    reg = register(service, act)
    service.payment_event(payment(service, reg, kind))
    assert service.get(reg["id"])["status"] in ("REJECTED", "EXPIRED")
    assert invariant(db, act.activity_id)["reserved"] == 0


def test_payment_after_expiry_is_refunded(service, db):
    act = activity(amount=100)
    reg = register(service, act)
    overdue(db, reg)
    service.payment_event(payment(service, reg))
    result = service.get(reg["id"])
    assert result["status"] == "EXPIRED"
    assert result["payment"]["status"] == "REFUND_PENDING"
    service.payment_event(payment(service, reg, "PaymentRefunded", version=2))
    assert service.get(reg["id"])["payment"]["status"] == "REFUNDED"
    assert invariant(db, act.activity_id)["reserved"] == 0


def test_expiry_and_payment_race(service, db):
    act = activity(amount=100)
    reg = register(service, act)
    overdue(db, reg)
    event = payment(service, reg)
    with ThreadPoolExecutor(max_workers=2) as pool:
        tasks = [pool.submit(service.expire), pool.submit(service.payment_event, event)]
        for task in tasks:
            task.result()
    assert service.get(reg["id"])["status"] == "EXPIRED"
    invariant(db, act.activity_id)


def test_cancel_and_payment_race(service, db):
    act = activity(amount=100)
    reg = register(service, act)
    event = payment(service, reg)
    with ThreadPoolExecutor(max_workers=2) as pool:
        tasks = [
            pool.submit(service.cancel, reg["id"], reg["user_id"]),
            pool.submit(service.payment_event, event),
        ]
        for task in tasks:
            task.result()
    result = service.get(reg["id"])
    assert result["status"] == "CANCELLED"
    assert result["payment"]["status"] == "REFUND_PENDING"
    invariant(db, act.activity_id)


def test_fifo_offer_expiry_and_acceptance(service, db):
    act = activity()
    first, second, third = [register(service, act) for _ in range(3)]
    service.cancel(first["id"], first["user_id"])
    assert service.get(second["id"])["status"] == "OFFERED"
    assert register(service, act)["status"] == "WAITLISTED"
    overdue(db, second)
    service.expire()
    assert service.get(third["id"])["status"] == "OFFERED"
    assert service.accept(third["id"], third["user_id"], act)["status"] == "CONFIRMED"
    assert service.accept(third["id"], third["user_id"], act)["status"] == "CONFIRMED"
    invariant(db, act.activity_id)


def test_paid_offer_creates_only_one_charge(service, db):
    act = activity(amount=100)
    first, second = [register(service, act) for _ in range(2)]
    service.cancel(first["id"], first["user_id"])
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: service.accept(second["id"], second["user_id"], act), range(2)))
    assert all(r["status"] == "PENDING_PAYMENT" for r in results)
    with db.transaction() as conn:
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM payment_attempts WHERE registration_id=%s", (second["id"],)
            ).fetchone()["n"]
            == 1
        )
    invariant(db, act.activity_id)


def test_counter_and_outbox_rollback_together(service, db, monkeypatch):
    act = activity()

    def fail(*args):
        raise RuntimeError("failure before commit")

    monkeypatch.setattr(service, "emit", fail)
    with pytest.raises(RuntimeError):
        register(service, act)
    with db.transaction() as conn:
        assert conn.execute("SELECT count(*) AS n FROM registrations").fetchone()["n"] == 0
        assert conn.execute("SELECT count(*) AS n FROM activity_inventory").fetchone()["n"] == 0


def test_capacity_is_immutable_even_in_sql(service, db):
    act = activity()
    register(service, act)
    with pytest.raises(psycopg.Error):
        with db.transaction() as conn:
            conn.execute(
                "UPDATE activity_inventory SET capacity=100 WHERE activity_id=%s", (act.activity_id,)
            )
    with pytest.raises(DomainError, match="IMMUTABLE_CAPACITY_MISMATCH"):
        register(service, act.model_copy(update={"capacity": 100}))


def test_presence_and_certificate_eligibility(service, db):
    act = activity()
    reg = register(service, act)
    organizer = uuid4()
    with pytest.raises(DomainError, match="OUTSIDE_CHECK_IN_WINDOW"):
        service.check_in(reg["id"], organizer, act)
    now = datetime.now(timezone.utc)
    ongoing = act.model_copy(
        update={"starts_at": now - timedelta(hours=1), "ends_at": now + timedelta(hours=1)}
    )
    service.check_in(reg["id"], organizer, ongoing)
    service.check_in(reg["id"], organizer, ongoing)
    ended = ongoing.model_copy(update={"ends_at": now - timedelta(seconds=1)})
    event = ActivityEvent(
        event_id=uuid4(), schema_version=1, type="ActivityEnded", activity_id=act.activity_id
    )
    service.activity_event(event, ended)
    service.activity_event(event, ended)
    with db.transaction() as conn:
        assert (
            conn.execute(
                "SELECT count(*) AS n FROM outbox WHERE payload->>'type'='AttendanceEligible'"
            ).fetchone()["n"]
            == 1
        )
    invariant(db, act.activity_id)


def test_cancelled_activity_releases_everyone(service, db):
    act = activity(amount=100)
    reg = register(service, act)
    register(service, act)
    event = ActivityEvent(
        event_id=uuid4(), schema_version=1, type="ActivityCancelled", activity_id=act.activity_id
    )
    service.activity_event(event, act)
    service.payment_event(payment(service, reg))
    assert service.get(reg["id"])["payment"]["status"] == "REFUND_PENDING"
    assert invariant(db, act.activity_id)["reserved"] == 0


def test_outbox_survives_kafka_failure(service, db, settings):
    reg = register(service, activity())
    workers = Workers(db, service, None, settings)

    class Producer:
        def __init__(self, error):
            self.error = error

        def produce(self, *args, **kwargs):
            kwargs["on_delivery"](self.error, None)

        def flush(self, timeout):
            return 0

    with pytest.raises(RuntimeError):
        workers.publish_once(Producer("offline"))
    assert service.get(reg["id"])["status"] == "CONFIRMED"
    with db.transaction() as conn:
        assert (
            conn.execute("SELECT count(*) AS n FROM outbox WHERE published_at IS NULL").fetchone()["n"] == 2
        )
    assert workers.publish_once(Producer(None))


def test_ownership_and_payment_amount_validation(service):
    reg = register(service, activity(amount=100))
    with pytest.raises(DomainError, match="REGISTRATION_NOT_FOUND"):
        service.cancel(reg["id"], uuid4())
    wrong = payment(service, reg).model_copy(update={"amount_minor": 1})
    with pytest.raises(DomainError, match="PAYMENT_CONTRACT_MISMATCH"):
        service.payment_event(wrong)
    assert service.get(reg["id"])["status"] == "PENDING_PAYMENT"
