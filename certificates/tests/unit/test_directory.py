import uuid

import pytest
from discovery import Kind, Response

from app import runtime
from app.integrations import directory as directory_module
from app.integrations.directory import Directory, PoisonMessage, TransientError
from app.services.storage import CertificateStorageError, S3CertificateStorage

ID = uuid.uuid4()


def respond(monkeypatch, status=200, body=b"{}", error=None):
    calls = []

    def fake_request(method, kind, path, options=None):
        calls.append((method, kind, path, options))
        if error:
            raise error
        return Response(status, {}, body)

    monkeypatch.setattr(directory_module, "request", fake_request)
    return calls


EVENT = (
    b'{"event_id": "%s", "title": "Software Week", '
    b'"starts_at": "2026-11-04T08:00:00-03:00", "ends_at": "2026-11-06T10:00:00Z"}'
)


def test_get_event_parses_and_sends_trace_id(monkeypatch):
    calls = respond(monkeypatch, body=EVENT % str(ID).encode())

    event = Directory().get_event(ID, "req-1")

    assert calls == [("GET", Kind.EVENTS, f"/api/v1/events/{ID}", {"headers": {"X-Trace-Id": "req-1"}})]
    assert event.id == ID
    assert event.title == "Software Week"
    assert event.starts_at.utcoffset().total_seconds() == -3 * 3600
    assert event.ends_at.tzinfo is not None


def test_get_event_ignores_extra_fields(monkeypatch):
    body = (
        b'{"event_id": "%s", "title": "T", "starts_at": "2026-11-04T08:00:00Z", '
        b'"ends_at": "2026-11-04T10:00:00Z", "status": "PUBLISHED", "extra": {"a": 1}}'
    ) % str(ID).encode()
    respond(monkeypatch, body=body)

    event = Directory().get_event(ID, "r")

    assert event.id == ID
    assert event.title == "T"


def test_naive_dates_are_rejected_as_transient(monkeypatch):
    respond(monkeypatch, body=b'{"event_id": "%s", "title": "T", "starts_at": "2026-11-04T08:00:00", "ends_at": "2026-11-04T10:00:00"}' % str(ID).encode())

    with pytest.raises(TransientError):
        Directory().get_event(ID, "r")


def test_missing_event_is_poison_and_other_failures_are_transient(monkeypatch):
    respond(monkeypatch, status=404)
    with pytest.raises(PoisonMessage) as raised:
        Directory().get_event(ID, "r")
    assert raised.value.reason == "EVENT_NOT_FOUND"

    for status in (500, 503, 401):
        respond(monkeypatch, status=status)
        with pytest.raises(TransientError):
            Directory().get_event(ID, "r")


@pytest.mark.parametrize("status", [500, 503])
def test_failures_are_transient(monkeypatch, status):
    respond(monkeypatch, status=status)

    for call in (Directory().get_event, Directory().get_participant_name):
        with pytest.raises(TransientError):
            call(ID, "r")


def test_transport_errors_are_transient_without_details(monkeypatch):
    respond(monkeypatch, error=OSError("connect to secret-host:1234 refused"))

    with pytest.raises(TransientError) as raised:
        Directory().get_event(ID, "r")
    assert "secret" not in str(raised.value)


OLD_ID_ONLY = (
    b'{"id": "00000000-0000-0000-0000-000000000001", "title": "T", '
    b'"starts_at": "2026-11-04T08:00:00Z", "ends_at": "2026-11-04T10:00:00Z"}'
)


@pytest.mark.parametrize("body", [b"not json", b"[]", b"{}", b'{"event_id": "x"}', OLD_ID_ONLY])
def test_invalid_bodies_are_transient(monkeypatch, body):
    respond(monkeypatch, body=body)

    with pytest.raises(TransientError):
        Directory().get_event(ID, "r")


def test_participant_name(monkeypatch):
    calls = respond(monkeypatch, body=b'{"id": "x", "name": "Alex Example"}')
    assert Directory().get_participant_name(ID, "r") == "Alex Example"
    assert calls[0][1:3] == (Kind.USER, f"/internal/users/{ID}")

    respond(monkeypatch, status=404)
    with pytest.raises(PoisonMessage) as raised:
        Directory().get_participant_name(ID, "r")
    assert raised.value.reason == "USER_NOT_FOUND"

    respond(monkeypatch, body=b'{"id": "x"}')
    with pytest.raises(TransientError):
        Directory().get_participant_name(ID, "r")


def test_runtime_creates_bucket_in_background_with_backoff(monkeypatch):
    class Flaky(S3CertificateStorage):
        attempts = 0

        def ensure_bucket(self):
            Flaky.attempts += 1
            if Flaky.attempts < 3:
                raise CertificateStorageError("down")

    instance = runtime.Runtime()
    monkeypatch.setattr(runtime, "get_storage", lambda: Flaky(None, "certificates"))
    monkeypatch.setattr(instance.stop, "wait", lambda delay: False)

    instance.ensure_bucket()

    assert Flaky.attempts == 3
