"""trace_id de ponta a ponta nas mensagens Kafka; sem PostgreSQL nem Kafka."""

from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from test_api_security import FakeEvents
from test_service import activity

from app.api import create_app
from app.config import Settings
from app.contracts import PaymentEvent
from app.security import Authenticator
from app.service import SubscriptionService

RID = "req-12345678"


class Result:
    def __init__(self, rows=None):
        self.rows = rows if rows is not None else []

    def fetchone(self):
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class FakeConn:
    """Registra os INSERTs na outbox; só `clock_timestamp()` é respondido."""

    def __init__(self):
        self.outbox = []

    def execute(self, sql, params=None):
        if "INSERT INTO outbox" in sql:
            self.outbox.append((params[1], params[3].obj))
            return Result()
        return Result([{"now": datetime.now(timezone.utc)}])

    def topic(self, name):
        return [payload for topic, payload in self.outbox if topic == name]


@pytest.fixture
def svc():
    return SubscriptionService(None, Settings(database_url="unused", workers_enabled=False))


def reg(status="CONFIRMED"):
    return {
        "id": uuid4(),
        "activity_id": uuid4(),
        "event_id": uuid4(),
        "user_id": uuid4(),
        "version": 2,
        "status": status,
        "expires_at": None,
        "amount_minor": 1500,
        "currency": "BRL",
    }


def test_emit_carries_trace_id_and_not_in_notifications(svc):
    conn = FakeConn()
    svc.emit(conn, reg(), "RegistrationConfirmed", RID)
    assert conn.topic(svc.settings.domain_topic)[0]["trace_id"] == RID
    note = conn.topic(svc.settings.notifications_topic)[0]
    assert "trace_id" not in note and "trace_id" not in note["payload"]


def test_emit_without_trace_id_sends_null(svc):
    conn = FakeConn()
    svc.emit(conn, reg(), "WaitlistOffered")
    payload = conn.topic(svc.settings.domain_topic)[0]
    assert "trace_id" in payload and payload["trace_id"] is None


EMITTED_TYPES = [
    "RegistrationWaitlisted",
    "WaitlistOffered",
    "RegistrationPendingPayment",
    "RegistrationConfirmed",
    "RegistrationCancelled",
    "RegistrationExpired",
    "RegistrationRejected",
    "AttendanceRecorded",
    "AttendanceEligible",
]


@pytest.mark.parametrize("event_type", EMITTED_TYPES)
def test_every_domain_event_carries_event_id(svc, event_type):
    conn, r = FakeConn(), reg()
    svc.emit(conn, r, event_type)
    assert conn.topic(svc.settings.domain_topic)[0]["event_id"] == str(r["event_id"])
    for note in conn.topic(svc.settings.notifications_topic):
        assert "event_id" not in note and "event_id" not in note["payload"]


def test_attendance_eligible_keeps_extra_fields_and_same_event_id(svc):
    conn, r = FakeConn(), reg()
    extra = {
        "event_id": r["event_id"],
        "attended_activities": 3,
        "total_activities": 4,
        "attendance_percentage": 75.0,
    }
    svc.emit(conn, r, "AttendanceEligible", extra=extra)
    payload = conn.topic(svc.settings.domain_topic)[0]
    assert payload["event_id"] == str(r["event_id"])
    assert {k: payload[k] for k in extra} == {k: str(v) if k == "event_id" else v for k, v in extra.items()}


class InventoryConn(FakeConn):
    def __init__(self, event_id):
        super().__init__()
        self.event_id = event_id

    def execute(self, sql, params=None):
        if "FROM activity_inventory" in sql:
            return Result([{"event_id": self.event_id}] if self.event_id else [])
        return super().execute(sql, params)


def test_emit_falls_back_to_inventory_event_id_when_registration_has_none(svc):
    inventory_event = uuid4()
    conn = InventoryConn(inventory_event)
    svc.emit(conn, {**reg(), "event_id": None}, "RegistrationConfirmed")
    assert conn.topic(svc.settings.domain_topic)[0]["event_id"] == str(inventory_event)


def test_emit_sends_null_event_id_when_nothing_is_known(svc):
    conn = InventoryConn(None)
    svc.emit(conn, {**reg(), "event_id": None}, "RegistrationConfirmed")
    payload = conn.topic(svc.settings.domain_topic)[0]
    assert "event_id" in payload and payload["event_id"] is None


def payment_result(**extra):
    return {
        "message_id": str(uuid4()),
        "schema_version": 1,
        "type": "PaymentApproved",
        "registration_id": str(uuid4()),
        "amount_minor": 1500,
        "currency": "BRL",
        **extra,
    }


@pytest.mark.parametrize("value", [RID, "x", "com espaços e ção", ""])
def test_payment_event_accepts_any_string_trace_id(value):
    assert PaymentEvent.model_validate(payment_result(trace_id=value)).trace_id == value


def test_payment_event_trace_id_optional():
    assert PaymentEvent.model_validate(payment_result(trace_id=None)).trace_id is None
    assert PaymentEvent.model_validate(payment_result()).trace_id is None


def test_payment_event_ignores_extra_fields():
    extras = {
        "payment_id": str(uuid4()),
        "user_id": str(uuid4()),
        "event_id": str(uuid4()),
        "status": "APPROVED",
        "reason": "ok",
        "occurred_at": "2026-11-01T22:15:00+00:00",
    }
    event = PaymentEvent.model_validate(payment_result(trace_id=RID, **extras))
    assert event.trace_id == RID
    assert not set(extras) & set(event.model_dump())


@pytest.mark.parametrize("currency", ["BRL", "brl", "Real", "USD1"])
def test_payment_event_currency_is_plain_string(currency):
    assert PaymentEvent.model_validate(payment_result(currency=currency)).currency == currency


def test_payment_event_still_rejects_unknown_type_and_missing_fields():
    with pytest.raises(ValidationError):
        PaymentEvent.model_validate(payment_result(type="PaymentFrobnicated"))
    for field in ("message_id", "registration_id", "amount_minor", "currency"):
        data = payment_result()
        del data[field]
        with pytest.raises(ValidationError):
            PaymentEvent.model_validate(data)
    with pytest.raises(ValidationError):
        PaymentEvent.model_validate(payment_result(schema_version=2))


def test_http_layer_passes_trace_id_to_service():
    settings = Settings(database_url="unused", workers_enabled=False)
    act = activity()
    app = create_app(settings, object(), FakeEvents(act), Authenticator(settings))
    seen = {}
    app.state.service.active_registration = lambda *a: None

    def create(user_id, activity, join_waitlist, trace_id=None):
        seen["create"] = trace_id
        return {"id": str(uuid4())}

    def cancel(registration_id, user_id, trace_id=None):
        seen["cancel"] = trace_id
        return {}

    app.state.service.create = create
    app.state.service.cancel = cancel
    headers = {"X-User-Id": str(uuid4()), "X-Trace-Id": RID}
    client = TestClient(app)  # sem lifespan: nenhum banco é aberto
    url = f"/api/v1/activities/{act.activity_id}/registrations"
    assert client.post(url, headers=headers, json={}).status_code == 201
    assert seen["create"] == RID
    assert client.post(f"/api/v1/registrations/{uuid4()}/cancel", headers=headers).status_code == 200
    assert seen["cancel"] == RID
    # Cabeçalho inválido: o middleware gera um id válido, que segue para o serviço.
    bad = {**headers, "X-Trace-Id": "x"}
    response = client.post(f"/api/v1/registrations/{uuid4()}/cancel", headers=bad)
    assert seen["cancel"] == response.headers["X-Trace-Id"] != "x"


def test_legacy_request_id_header_is_ignored_and_not_echoed():
    settings = Settings(database_url="unused", workers_enabled=False)
    app = create_app(settings, object(), FakeEvents(activity()), Authenticator(settings))
    response = TestClient(app).get("/openapi.json", headers={"X-Request-Id": RID})
    assert "X-Request-Id" not in response.headers
    assert response.headers["X-Trace-Id"] != RID
