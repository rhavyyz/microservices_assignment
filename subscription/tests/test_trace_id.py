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
