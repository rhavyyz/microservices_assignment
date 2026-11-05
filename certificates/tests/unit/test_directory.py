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


ACTIVITY = (
    b'{"id": "%s", "event_id": "%s", "title": "Talk", '
    b'"starts_at": "2026-11-04T08:00:00-03:00", "ends_at": "2026-11-04T10:00:00Z"}'
)


def test_get_activity_parses_and_sends_request_id(monkeypatch):
    event_id = uuid.uuid4()
    calls = respond(monkeypatch, body=ACTIVITY % (str(ID).encode(), str(event_id).encode()))

    activity = Directory().get_activity(ID, "req-1")

    assert calls == [("GET", Kind.EVENTS, f"/activities/{ID}", {"headers": {"X-Request-Id": "req-1"}})]
    assert activity.event_id == event_id
    assert activity.title == "Talk"
    assert activity.starts_at.utcoffset().total_seconds() == -3 * 3600
    assert activity.ends_at.tzinfo is not None


def test_naive_dates_are_rejected_as_transient(monkeypatch):
    respond(monkeypatch, body=b'{"id": "%s", "event_id": "%s", "title": "T", "starts_at": "2026-11-04T08:00:00", "ends_at": "2026-11-04T10:00:00"}' % (str(ID).encode(), str(ID).encode()))

    with pytest.raises(TransientError):
        Directory().get_activity(ID, "r")


def test_activity_404_is_poison(monkeypatch):
    respond(monkeypatch, status=404)

    with pytest.raises(PoisonMessage) as raised:
        Directory().get_activity(ID, "r")
    assert raised.value.reason == "ACTIVITY_NOT_FOUND"


@pytest.mark.parametrize("status", [500, 503, 401, 429])
def test_other_statuses_are_transient(monkeypatch, status):
    respond(monkeypatch, status=status)

    for call in (Directory().get_activity, Directory().get_event_title, Directory().get_participant_name):
        with pytest.raises(TransientError):
            call(ID, "r")


def test_transport_errors_are_transient_without_details(monkeypatch):
    respond(monkeypatch, error=OSError("connect to secret-host:1234 refused"))

    with pytest.raises(TransientError) as raised:
        Directory().get_activity(ID, "r")
    assert "secret" not in str(raised.value)


@pytest.mark.parametrize("body", [b"not json", b"[]", b"{}", b'{"id": "x"}'])
def test_invalid_bodies_are_transient(monkeypatch, body):
    respond(monkeypatch, body=body)

    with pytest.raises(TransientError):
        Directory().get_activity(ID, "r")


def test_event_title_and_missing_event(monkeypatch):
    calls = respond(monkeypatch, body=b'{"title": "Software Week"}')
    assert Directory().get_event_title(ID, "r") == "Software Week"
    assert calls[0][1:3] == (Kind.EVENTS, f"/events/{ID}")

    respond(monkeypatch, status=404)
    assert Directory().get_event_title(ID, "r") is None

    respond(monkeypatch, body=b'{"title": ""}')
    with pytest.raises(TransientError):
        Directory().get_event_title(ID, "r")


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
