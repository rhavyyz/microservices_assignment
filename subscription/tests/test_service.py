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


def register(service, act, user=None):
    return service.create(user or uuid4(), act)


def payment(reg, kind="PaymentApproved", message_id=None):
    return PaymentEvent(
        message_id=message_id or uuid4(),
        schema_version=1,
        type=kind,
        registration_id=reg["id"],
        amount_minor=reg["amount_minor"],
        currency=reg["currency"],
    )


def domain_events(db, reg, kind):
    with db.transaction() as conn:
        return conn.execute(
            "SELECT payload FROM outbox WHERE payload->>'type'=%s AND payload->>'registration_id'=%s",
            (kind, str(reg["id"])),
        ).fetchall()


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


def test_concurrent_requests_same_user_single_registration(service, db):
    act, user = activity(), uuid4()
    with ThreadPoolExecutor(max_workers=10) as pool:
        results = list(pool.map(lambda _: register(service, act, user), range(20)))
    assert len({r["id"] for r in results}) == 1
    assert invariant(db, act.activity_id)["confirmed"] == 1
    with db.transaction() as conn:
        count = conn.execute("SELECT count(*) AS n FROM registrations WHERE activity_id=%s", (act.activity_id,)).fetchone()
    assert count["n"] == 1


def test_second_signup_returns_same_registration(service, db):
    act, user = activity(10), uuid4()
    first = register(service, act, user)
    assert register(service, act, user) == first
    assert service.active_registration(user, act.activity_id) == first
    assert service.active_registration(uuid4(), act.activity_id) is None
    assert invariant(db, act.activity_id)["confirmed"] == 1


def test_signup_after_cancel_creates_new_registration(service, db):
    act, user = activity(1), uuid4()
    first = register(service, act, user)
    service.cancel(first["id"], user)
    assert service.active_registration(user, act.activity_id) is None
    second = register(service, act, user)
    assert second["id"] != first["id"]
    assert second["status"] == "CONFIRMED"
    assert invariant(db, act.activity_id)["confirmed"] == 1


@pytest.mark.parametrize("final", ["REJECTED", "EXPIRED"])
def test_signup_after_rejected_or_expired_creates_new_registration(service, db, final):
    act, user = activity(1, amount=100), uuid4()
    first = register(service, act, user)
    if final == "REJECTED":
        service.payment_event(payment(first, "PaymentDeclined"))
    else:
        overdue(db, first)
        service.expire()
    assert service.get(first["id"])["status"] == final
    second = register(service, act, user)
    assert second["id"] != first["id"]
    assert second["status"] == "PENDING_PAYMENT"
    assert invariant(db, act.activity_id)["reserved"] == 1


def test_payment_confirmation_duplicate_and_stale(service, db):
    act = activity(amount=100)
    reg = register(service, act)
    event = payment(reg)
    service.payment_event(event)
    service.payment_event(event)
    service.payment_event(payment(reg, "PaymentDeclined"))
    assert service.get(reg["id"])["status"] == "CONFIRMED"
    assert invariant(db, act.activity_id)["confirmed"] == 1
    assert len(domain_events(db, reg, "RegistrationConfirmed")) == 1


def test_declined_releases_seat_and_promotes_waitlist(service, db):
    act = activity(amount=100)
    reg, waiting = register(service, act), register(service, act)
    service.payment_event(payment(reg, "PaymentDeclined"))
    assert service.get(reg["id"])["status"] == "REJECTED"
    assert service.get(waiting["id"])["status"] == "OFFERED"
    assert invariant(db, act.activity_id)["reserved"] == 1


@pytest.mark.parametrize("kind", ["PaymentCreated", "PaymentExpired", "PaymentCancelled", "PaymentRefunded"])
def test_informational_payment_events_keep_the_reservation(service, db, kind):
    act = activity(amount=100)
    reg = register(service, act)
    service.payment_event(payment(reg, kind))
    assert service.get(reg["id"])["status"] == "PENDING_PAYMENT"
    assert invariant(db, act.activity_id)["reserved"] == 1


def test_payment_after_expiry_is_ignored(service, db):
    act = activity(amount=100)
    reg = register(service, act)
    overdue(db, reg)
    service.payment_event(payment(reg))
    assert service.get(reg["id"])["status"] == "EXPIRED"
    assert domain_events(db, reg, "RegistrationConfirmed") == []
    assert invariant(db, act.activity_id)["reserved"] == 0


def test_unknown_registration_payment_is_ignored(service):
    service.payment_event(payment({"id": uuid4(), "amount_minor": 100, "currency": "BRL"}))


def test_expiry_and_payment_race(service, db):
    act = activity(amount=100)
    reg = register(service, act)
    overdue(db, reg)
    event = payment(reg)
    with ThreadPoolExecutor(max_workers=2) as pool:
        tasks = [pool.submit(service.expire), pool.submit(service.payment_event, event)]
        for task in tasks:
            task.result()
    assert service.get(reg["id"])["status"] == "EXPIRED"
    invariant(db, act.activity_id)


def test_cancel_and_payment_race(service, db):
    act = activity(amount=100)
    reg = register(service, act)
    event = payment(reg)
    with ThreadPoolExecutor(max_workers=2) as pool:
        tasks = [
            pool.submit(service.cancel, reg["id"], reg["user_id"]),
            pool.submit(service.payment_event, event),
        ]
        for task in tasks:
            task.result()
    assert service.get(reg["id"])["status"] == "CANCELLED"
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


def test_paid_offer_announces_pending_payment_once(service, db):
    act = activity(amount=100)
    first, second = [register(service, act) for _ in range(2)]
    service.cancel(first["id"], first["user_id"])
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: service.accept(second["id"], second["user_id"], act), range(2)))
    assert all(r["status"] == "PENDING_PAYMENT" for r in results)
    # A segunda chamada concorrente encontra a inscrição já em PENDING_PAYMENT e não emite de novo.
    assert len(domain_events(db, second, "RegistrationPendingPayment")) == 1
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


def ongoing(act):
    now = datetime.now(timezone.utc)
    return act.model_copy(update={"starts_at": now - timedelta(hours=1), "ends_at": now + timedelta(hours=1)})


def finished(act):
    return ongoing(act).model_copy(update={"ends_at": datetime.now(timezone.utc) - timedelta(seconds=1)})


def end(service, act, kind="ActivityEnded", message_id=None):
    event = ActivityEvent(
        message_id=message_id or uuid4(), schema_version=1, type=kind, activity_id=act.activity_id
    )
    service.activity_event(event, finished(act))
    return event


def sibling(act):
    return act.model_copy(update={"activity_id": uuid4()})


def eligible(db, user=None):
    with db.transaction() as conn:
        rows = conn.execute(
            "SELECT payload, message_key FROM outbox WHERE payload->>'type'='AttendanceEligible' "
            "ORDER BY sequence"
        ).fetchall()
    return [r for r in rows if user is None or r["payload"]["user_id"] == str(user)]


def test_presence_and_certificate_eligibility(service, db):
    act = activity()
    reg = register(service, act)
    organizer = uuid4()
    with pytest.raises(DomainError, match="OUTSIDE_CHECK_IN_WINDOW"):
        service.check_in(reg["id"], organizer, act)
    service.check_in(reg["id"], organizer, ongoing(act))
    service.check_in(reg["id"], organizer, ongoing(act))
    event = end(service, act)
    service.activity_event(event, finished(act))
    rows = eligible(db)
    assert len(rows) == 1
    payload = rows[0]["payload"]
    assert rows[0]["message_key"] == reg["id"]
    assert payload["parent_event_id"] == str(act.event_id)
    assert payload["message_id"] != str(act.event_id)
    assert payload["registration_id"] == reg["id"]
    assert payload["activity_id"] == str(act.activity_id)
    assert (payload["attended_activities"], payload["total_activities"]) == (1, 1)
    assert payload["attendance_percentage"] == 100.0
    assert payload["schema_version"] == 1
    with db.transaction() as conn:
        assert conn.execute("SELECT count(*) AS n FROM event_attendance_emitted").fetchone()["n"] == 1
        recorded = conn.execute(
            "SELECT count(*) AS n FROM outbox WHERE payload->>'type'='AttendanceRecorded'"
        ).fetchone()["n"]
        assert not conn.execute("SELECT eligible_emitted FROM attendance").fetchone()["eligible_emitted"]
    assert recorded == 1
    invariant(db, act.activity_id)


def event_activities(count):
    first = activity(capacity=5)
    return [first] + [sibling(first) for _ in range(count - 1)]


def enroll(service, acts, user, attend):
    """Inscreve a pessoa em todas as atividades e registra check-in nas indicadas."""
    regs = []
    for index, act in enumerate(acts):
        reg = service.create(user, act)
        regs.append(reg)
        if index in attend:
            service.check_in(reg["id"], uuid4(), ongoing(act))
    return regs


def test_full_attendance_emits_once_at_last_activity(service, db):
    acts, user = event_activities(3), uuid4()
    enroll(service, acts, user, {0, 1, 2})
    end(service, acts[0])
    end(service, acts[1])
    assert eligible(db) == []
    end(service, acts[2])
    rows = eligible(db, user)
    assert len(rows) == 1
    assert rows[0]["payload"]["activity_id"] == str(acts[2].activity_id)
    assert rows[0]["payload"]["attendance_percentage"] == 100.0
    assert rows[0]["payload"]["total_activities"] == 3


@pytest.mark.parametrize(
    "total,attended,emits,percent",
    [(3, 2, False, 66.67), (4, 3, True, 75.0), (4, 2, False, 50.0), (1, 0, False, 0.0), (1, 1, True, 100.0)],
)
def test_threshold_boundary(service, db, total, attended, emits, percent):
    acts, user = event_activities(total), uuid4()
    enroll(service, acts, user, set(range(attended)))
    for act in acts:
        end(service, act)
    rows = eligible(db, user)
    assert len(rows) == int(emits)
    if emits:
        assert rows[0]["payload"]["attendance_percentage"] == percent
        assert rows[0]["payload"]["attended_activities"] == attended


def test_replay_does_not_emit_again(service, db):
    acts, user = event_activities(2), uuid4()
    enroll(service, acts[:1], user, {0})
    first = end(service, acts[0])
    assert len(eligible(db, user)) == 1
    service.activity_event(first, finished(acts[0]))
    assert len(eligible(db, user)) == 1


def test_late_registration_after_emission_does_not_emit_again(service, db):
    acts, user = event_activities(2), uuid4()
    enroll(service, acts[:1], user, {0})
    end(service, acts[0])
    assert len(eligible(db, user)) == 1
    # Inscrição tardia em outra atividade do mesmo evento: a primeira conclusão vence.
    assert service.create(user, acts[1])["status"] == "CONFIRMED"
    service.check_in(service.active_registration(user, acts[1].activity_id)["id"], uuid4(), ongoing(acts[1]))
    end(service, acts[1])
    assert len(eligible(db, user)) == 1
    with db.transaction() as conn:
        assert conn.execute("SELECT count(*) AS n FROM event_attendance_emitted").fetchone()["n"] == 1


def test_cancel_of_last_activity_evaluates_remaining(service, db):
    acts, user = event_activities(3), uuid4()
    enroll(service, acts, user, {0, 1})
    end(service, acts[0])
    end(service, acts[1])
    assert eligible(db) == []
    cancel = end(service, acts[2], "ActivityCancelled")
    rows = eligible(db, user)
    assert len(rows) == 1
    assert rows[0]["payload"]["attendance_percentage"] == 100.0
    assert (rows[0]["payload"]["attended_activities"], rows[0]["payload"]["total_activities"]) == (2, 2)
    assert rows[0]["payload"]["activity_id"] == str(acts[2].activity_id)
    service.activity_event(cancel, finished(acts[2]))
    assert len(eligible(db, user)) == 1


def test_cancel_with_half_attendance_does_not_emit(service, db):
    acts, user = event_activities(3), uuid4()
    enroll(service, acts, user, {0})
    end(service, acts[0])
    end(service, acts[1])
    end(service, acts[2], "ActivityCancelled")
    assert eligible(db) == []


def test_cancel_of_only_confirmed_activity_emits_nothing(service, db):
    acts, user = event_activities(2), uuid4()
    service.create(user, acts[0])
    end(service, acts[0], "ActivityCancelled")
    assert eligible(db) == []


def test_nothing_while_registered_activity_not_ended(service, db):
    acts, user = event_activities(2), uuid4()
    enroll(service, acts, user, {0, 1})
    end(service, acts[0])
    assert eligible(db) == []
    # Quem só está em atividade não encerrada também não recebe nada.
    other = uuid4()
    service.create(other, acts[1])
    end(service, acts[0], message_id=uuid4())
    assert eligible(db, other) == []


def test_cancelled_activity_does_not_count(service, db):
    acts, user = event_activities(3), uuid4()
    enroll(service, acts, user, {0, 1})
    end(service, acts[2], "ActivityCancelled")
    end(service, acts[0])
    assert eligible(db) == []
    end(service, acts[1])
    rows = eligible(db, user)
    assert len(rows) == 1
    assert (rows[0]["payload"]["attended_activities"], rows[0]["payload"]["total_activities"]) == (2, 2)


def test_non_confirmed_registrations_are_excluded(service, db):
    first = activity(capacity=1)
    acts, user = [first, sibling(first), sibling(first), sibling(first)], uuid4()
    service.check_in(service.create(user, acts[0])["id"], uuid4(), ongoing(acts[0]))
    # Lista de espera, cancelada e reserva sem pagamento não entram no denominador.
    service.create(uuid4(), acts[1])
    waiting = service.create(user, acts[1])
    assert waiting["status"] == "WAITLISTED"
    cancelled = service.create(user, acts[2])
    service.cancel(cancelled["id"], user)
    pending = service.create(user, sibling(first).model_copy(update={"amount_minor": 100}))
    assert pending["status"] == "PENDING_PAYMENT"
    for act in acts:
        end(service, act)
    rows = eligible(db, user)
    assert len(rows) == 1
    assert (rows[0]["payload"]["attended_activities"], rows[0]["payload"]["total_activities"]) == (1, 1)


def test_users_are_evaluated_independently(service, db):
    acts, good, bad = event_activities(2), uuid4(), uuid4()
    enroll(service, acts, good, {0, 1})
    enroll(service, acts, bad, {0})
    for act in acts:
        end(service, act)
    assert len(eligible(db, good)) == 1
    assert eligible(db, bad) == []


def test_concurrent_end_of_last_activities_emits_once(service, db, settings):
    acts, user = event_activities(2), uuid4()
    enroll(service, acts, user, {0, 1})
    replica = SubscriptionService(db, settings)
    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(lambda pair: end(pair[0], pair[1]), [(service, acts[0]), (replica, acts[1])]))
    assert len(eligible(db, user)) == 1


def test_cancelled_activity_releases_everyone(service, db):
    act = activity(amount=100)
    reg = register(service, act)
    register(service, act)
    event = ActivityEvent(
        message_id=uuid4(), schema_version=1, type="ActivityCancelled", activity_id=act.activity_id
    )
    service.activity_event(event, act)
    service.payment_event(payment(reg))
    assert service.get(reg["id"])["status"] == "CANCELLED"
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


@pytest.mark.parametrize("kind", ["ActivityEnded", "ActivityCancelled"])
def test_activity_event_fetch_carries_no_identity(service, db, settings, kind):
    act = activity().model_copy(update={"ends_at": datetime.now(timezone.utc) - timedelta(minutes=1)})
    calls = []

    class FakeServices:
        def activity(self, *args, **kwargs):
            calls.append((args, kwargs))
            return act

    workers = Workers(db, service, FakeServices(), settings)
    payload = {"message_id": str(uuid4()), "schema_version": 1, "type": kind, "activity_id": str(act.activity_id)}
    workers.process(settings.events_topic, payload)
    assert calls == [((act.activity_id,), {})]


def test_ownership_and_payment_amount_mismatch_is_ignored(service):
    reg = register(service, activity(amount=100))
    with pytest.raises(DomainError, match="REGISTRATION_NOT_FOUND"):
        service.cancel(reg["id"], uuid4())
    wrong = payment(reg).model_copy(update={"amount_minor": 1})
    service.payment_event(wrong)
    assert service.get(reg["id"])["status"] == "PENDING_PAYMENT"


def test_internal_registration_exposes_facts_and_parent_event(service):
    act = activity(amount=100)
    reg = register(service, act)
    facts = service.internal_registration(reg["id"])
    assert facts == {
        "registration_id": reg["id"],
        "user_id": reg["user_id"],
        "status": "PENDING_PAYMENT",
        "amount_minor": 100,
        "currency": "BRL",
        "expires_at": facts["expires_at"],
        "parent_event_id": act.event_id,
    }
    assert facts["expires_at"] is not None
    with pytest.raises(DomainError, match="REGISTRATION_NOT_FOUND"):
        service.internal_registration(uuid4())
