"""Inscrições declarativa: eventos próprios, regras sobre resultados de Pagamentos e rota interna.

Sem PostgreSQL nem Kafka: uma conexão roteirizada responde às consultas do serviço.
"""

from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_api_security import FakeEvents
from test_service import activity
from test_trace_id import Result, reg

from app.api import create_app
from app.config import Settings
from app.contracts import DomainError, PaymentEvent
from app.security import Authenticator
from app.service import SubscriptionService

RID = "req-12345678"
TYPES = [
    "PaymentCreated",
    "PaymentApproved",
    "PaymentDeclined",
    "PaymentExpired",
    "PaymentCancelled",
    "PaymentRefunded",
]


def now():
    return datetime.now(timezone.utc)


class Conn:
    """Simula as consultas usadas por create, accept e payment_event, registrando outbox e escritas."""

    def __init__(self, registration=None, db_now=None, act=None):
        self.reg = registration
        self.inv = {
            "activity_id": act.activity_id if act else uuid4(),
            "event_id": act.event_id if act else uuid4(),
            "capacity": 5,
            "reserved": 0,
            "confirmed": 0,
            "lifecycle": "OPEN",
        }
        self.db_now = db_now or now()
        self.seen = set()
        self.outbox, self.writes, self.inserted = [], [], None

    def topic(self, name):
        return [p for t, p in self.outbox if t == name]

    def execute(self, sql, params=None):
        if "INSERT INTO outbox" in sql:
            self.outbox.append((params[1], params[3].obj))
            return Result()
        if "clock_timestamp() AS now" in sql:
            return Result([{"now": self.db_now}])
        if "FROM activity_inventory" in sql:
            return Result([self.inv])
        if "INSERT INTO inbox" in sql:
            if params[0] in self.seen:
                return Result()
            self.seen.add(params[0])
            return Result([{"message_id": params[0]}])
        if "INSERT INTO registrations" in sql:
            self.reg = {
                "id": params[0],
                "activity_id": params[1],
                "user_id": params[2],
                "status": "WAITLISTED",
                "amount_minor": params[3],
                "currency": params[4],
                "event_id": params[5],
                "expires_at": None,
                "version": 1,
            }
            self.inserted = params
            return Result([self.reg])
        if "UPDATE registrations SET status" in sql:
            self.reg = {
                **self.reg,
                "status": params[0],
                "expires_at": params[1],
                "version": self.reg["version"] + 1,
            }
            return Result([self.reg])
        if "FROM registrations WHERE id=" in sql:
            return Result([self.reg] if self.reg else [])
        if sql.startswith("UPDATE"):
            self.writes.append(sql)
            return Result()
        # Inscrição viva, reservas vencidas e fila de espera: nenhuma.
        return Result([])


def service_with(conn):
    svc = SubscriptionService(None, Settings(database_url="unused", workers_enabled=False))

    @contextmanager
    def transaction():
        yield conn

    svc.db = type("Db", (), {"transaction": staticmethod(transaction)})()
    return svc


def domain_types(conn, svc):
    return [p["type"] for p in conn.topic(svc.settings.domain_topic)]


# --- RegistrationPendingPayment -------------------------------------------------------------


def test_paid_create_emits_pending_payment_with_trace_id_and_stores_event_id():
    act = activity(capacity=5, amount=1500)
    conn = Conn(act=act)
    svc = service_with(conn)
    result = svc.create(uuid4(), act, True, RID)
    assert result["status"] == "PENDING_PAYMENT"
    assert conn.inserted[5] == act.event_id
    events = conn.topic(svc.settings.domain_topic)
    assert [e["type"] for e in events] == ["RegistrationPendingPayment"]
    assert events[0]["trace_id"] == RID and events[0]["status"] == "PENDING_PAYMENT"
    # Nada para Pagamentos: só o evento de domínio (este tipo não gera notificação).
    assert [t for t, _ in conn.outbox] == [svc.settings.domain_topic]


def test_free_create_does_not_emit_pending_payment():
    act = activity(capacity=5)
    conn = Conn(act=act)
    svc = service_with(conn)
    assert svc.create(uuid4(), act, True, RID)["status"] == "CONFIRMED"
    assert domain_types(conn, svc) == ["RegistrationConfirmed"]


@pytest.mark.parametrize(
    "amount,status,expected",
    [(1500, "PENDING_PAYMENT", "RegistrationPendingPayment"), (0, "CONFIRMED", "RegistrationConfirmed")],
)
def test_accept_offer_emits_pending_payment_only_when_paid(amount, status, expected):
    registration = reg("OFFERED") | {"amount_minor": amount, "expires_at": now() + timedelta(minutes=5)}
    conn = Conn(registration)
    svc = service_with(conn)
    result = svc.accept(registration["id"], registration["user_id"], activity(amount=amount), RID)
    assert result["status"] == status
    events = conn.topic(svc.settings.domain_topic)
    assert [e["type"] for e in events] == [expected]
    assert events[0]["trace_id"] == RID


# --- PaymentEvent relaxado ------------------------------------------------------------------


def message(kind="PaymentApproved", **extra):
    return {
        "message_id": str(uuid4()),
        "schema_version": 1,
        "type": kind,
        "registration_id": str(uuid4()),
        "amount_minor": 1500,
        "currency": "BRL",
        **extra,
    }


@pytest.mark.parametrize("kind", TYPES)
def test_payment_event_accepts_all_six_types(kind):
    assert PaymentEvent.model_validate(message(kind)).type == kind


def test_payment_event_ignores_extras_and_attempt_fields_are_gone():
    event = PaymentEvent.model_validate(
        message(
            trace_id=RID,
            payment_id=str(uuid4()),
            reason="x",
            payment_attempt_id=str(uuid4()),
            provider_version=3,
        )
    )
    dumped = event.model_dump()
    assert event.trace_id == RID
    for name in ("payment_id", "reason", "payment_attempt_id", "provider_version"):
        assert name not in dumped and name not in PaymentEvent.model_fields


@pytest.mark.parametrize(
    "bad",
    [
        {"amount_minor": -1},
        {"amount_minor": 1.5},
        {"amount_minor": "10"},
        {"schema_version": 2},
        {"type": "PaymentRequested"},
        {"registration_id": "x"},
    ],
)
def test_payment_event_rejects_invalid_contract(bad):
    with pytest.raises(ValidationError):
        PaymentEvent.model_validate(message(**bad))


# --- regras de payment_event ----------------------------------------------------------------


def pending(**overrides):
    return reg("PENDING_PAYMENT") | {"expires_at": now() + timedelta(minutes=5)} | overrides


def apply(registration, kind, db_now=None, **changes):
    conn = Conn(registration, db_now)
    svc = service_with(conn)
    data = message(kind, registration_id=str(registration["id"]), trace_id=RID) | changes
    svc.payment_event(PaymentEvent.model_validate(data))
    return conn, svc


def test_approved_confirms_pending_registration_and_propagates_trace_id():
    conn, svc = apply(pending(), "PaymentApproved")
    assert conn.reg["status"] == "CONFIRMED"
    events = conn.topic(svc.settings.domain_topic)
    assert [e["type"] for e in events] == ["RegistrationConfirmed"]
    assert events[0]["trace_id"] == RID
    assert len(conn.topic(svc.settings.notifications_topic)) == 1


@pytest.mark.parametrize("status", ["CONFIRMED", "CANCELLED", "EXPIRED", "REJECTED", "WAITLISTED", "OFFERED"])
def test_approved_ignored_when_not_pending_payment(status):
    registration = reg(status)
    conn, _ = apply(registration, "PaymentApproved")
    assert conn.reg == registration and conn.outbox == []


def test_approved_ignored_after_reservation_deadline_by_db_clock():
    # O relógio do banco já passou do prazo, mesmo que a linha ainda esteja PENDING_PAYMENT.
    registration = pending(expires_at=now() + timedelta(minutes=1))
    conn, _ = apply(registration, "PaymentApproved", db_now=now() + timedelta(minutes=2))
    assert conn.reg == registration and conn.outbox == []


@pytest.mark.parametrize("change", [{"amount_minor": 1}, {"currency": "USD"}])
def test_approved_ignored_on_snapshot_mismatch(change):
    registration = pending()
    conn, _ = apply(registration, "PaymentApproved", **change)
    assert conn.reg == registration and conn.outbox == []


def test_declined_rejects_and_promotes_waitlist():
    registration = pending()
    waiting = reg("WAITLISTED") | {"activity_id": registration["activity_id"]}

    class WithWaitlist(Conn):
        def execute(self, sql, params=None):
            if "JOIN waitlist_entries" in sql:
                return Result([waiting])
            return super().execute(sql, params)

    conn = WithWaitlist(registration)
    svc = service_with(conn)
    data = message("PaymentDeclined", registration_id=str(registration["id"]), trace_id=RID)
    svc.payment_event(PaymentEvent.model_validate(data))
    events = conn.topic(svc.settings.domain_topic)
    assert [e["type"] for e in events] == ["RegistrationRejected", "WaitlistOffered"]
    assert events[0]["trace_id"] == RID and events[1]["trace_id"] is None


def test_declined_ignored_when_not_pending_payment():
    registration = reg("CONFIRMED")
    conn, _ = apply(registration, "PaymentDeclined")
    assert conn.reg == registration and conn.outbox == []


@pytest.mark.parametrize("kind", ["PaymentCreated", "PaymentExpired", "PaymentCancelled", "PaymentRefunded"])
@pytest.mark.parametrize("status", ["PENDING_PAYMENT", "CONFIRMED", "CANCELLED"])
def test_informational_types_change_nothing(kind, status):
    registration = pending() if status == "PENDING_PAYMENT" else reg(status)
    conn, _ = apply(registration, kind)
    assert conn.reg == registration and conn.outbox == [] and conn.writes == []


def test_unknown_registration_is_ignored_not_quarantined():
    conn = Conn(None)
    svc = service_with(conn)
    svc.payment_event(PaymentEvent.model_validate(message("PaymentApproved")))
    assert conn.outbox == []


def test_duplicate_message_id_is_processed_once():
    registration = pending()
    conn = Conn(registration)
    svc = service_with(conn)
    event = PaymentEvent.model_validate(message("PaymentDeclined", registration_id=str(registration["id"])))
    svc.payment_event(event)
    svc.payment_event(event)
    assert domain_types(conn, svc).count("RegistrationRejected") == 1


# --- GET /internal/registrations/{id} -------------------------------------------------------


class FakeRegistrations:
    def __init__(self, row=None):
        self.row, self.asked = row, []

    def internal_registration(self, registration_id):
        self.asked.append(registration_id)
        if self.row is None:
            raise DomainError(404, "REGISTRATION_NOT_FOUND")
        return self.row


def internal_client(row):
    settings = Settings(database_url="unused", workers_enabled=False)
    app = create_app(settings, object(), FakeEvents(activity()), Authenticator(settings))
    fake = FakeRegistrations(row)
    app.state.service.internal_registration = fake.internal_registration
    return TestClient(app), fake  # sem lifespan: nenhum banco é aberto


def test_internal_registration_returns_contract_shape_without_auth():
    expires = now() + timedelta(minutes=15)
    row = {
        "registration_id": uuid4(),
        "user_id": uuid4(),
        "status": "PENDING_PAYMENT",
        "amount_minor": 2500,
        "currency": "BRL",
        "expires_at": expires,
        "event_id": uuid4(),
        "version": 9,
    }
    client, fake = internal_client(row)
    response = client.get(f"/internal/registrations/{row['registration_id']}")
    assert response.status_code == 200
    body = response.json()
    assert set(body) == {
        "registration_id",
        "user_id",
        "status",
        "amount_minor",
        "currency",
        "expires_at",
        "event_id",
    }
    assert body["registration_id"] == str(row["registration_id"]) and body["status"] == "PENDING_PAYMENT"
    assert body["amount_minor"] == 2500 and body["event_id"] == str(row["event_id"])
    assert datetime.fromisoformat(body["expires_at"]) == expires
    assert str(fake.asked[0]) == str(row["registration_id"])


def test_internal_registration_nullable_fields():
    row = {
        "registration_id": uuid4(),
        "user_id": uuid4(),
        "status": "CONFIRMED",
        "amount_minor": 0,
        "currency": "BRL",
        "expires_at": None,
        "event_id": None,
    }
    client, _ = internal_client(row)
    body = client.get(f"/internal/registrations/{row['registration_id']}").json()
    assert body["expires_at"] is None and body["event_id"] is None


@pytest.mark.parametrize("path", [str(uuid4()), "not-a-uuid"])
def test_internal_registration_404_problem_style(path):
    client, _ = internal_client(None)
    response = client.get(f"/internal/registrations/{path}")
    assert response.status_code == 404
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json()["code"] == "REGISTRATION_NOT_FOUND"


def test_internal_routes_stay_out_of_openapi_and_gateway_routes():
    from scripts.register_gateway import ROUTES

    client, _ = internal_client(None)
    spec = client.get("/openapi.json").json()
    assert not [p for p in spec["paths"] if p.startswith("/internal")]
    assert not [path for _, path, _ in ROUTES if path.startswith("/internal")]
