"""One access line per request, in the platform-wide format."""

import logging
import re
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app

USER = uuid.uuid4()
TRACE = "trace-12345678"
LINE = re.compile(
    r"^(?P<method>[A-Z]+) (?P<path>\S+) status=(?P<status>\d{3}) duration=\d+ms "
    r"user=(?P<user>\S+) trace_id=(?P<trace>\S+)$"
)


@pytest.fixture
def access(caplog):
    caplog.set_level(logging.INFO, logger="app.access")

    def lines():
        return [r.getMessage() for r in caplog.records if r.name == "app.access"]

    return lines


def test_line_has_the_platform_format_and_echoes_a_valid_trace_id(client, access):
    response = client.get("/nope", headers={"X-User-Id": str(USER), "X-Trace-Id": TRACE})

    (line,) = access()
    fields = LINE.match(line).groupdict()
    assert fields["method"] == "GET" and fields["path"] == "/nope" and fields["status"] == "404"
    assert fields["user"] == str(USER)
    assert fields["trace"] == TRACE == response.headers["X-Trace-Id"]


def test_invalid_trace_id_is_replaced_and_the_replacement_is_logged(client, access):
    response = client.get("/nope", headers={"X-Trace-Id": "bad id\nforged"})

    (line,) = access()
    replacement = response.headers["X-Trace-Id"]
    uuid.UUID(replacement)
    assert LINE.match(line).group("trace") == replacement
    assert "forged" not in line


def test_user_is_dash_without_a_valid_uuid(client, access):
    client.get("/nope")
    client.get("/nope", headers={"X-User-Id": "not-a-uuid"})

    assert [LINE.match(line).group("user") for line in access()] == ["-", "-"]


def test_forged_user_id_cannot_inject_log_lines(client, access):
    client.get("/nope", headers={"X-User-Id": "x\tfake"})
    client.get("/nope", headers={"X-User-Id": f"{USER}\tfake status=200"})

    lines = access()
    assert len(lines) == 2
    assert all(LINE.match(line) and "fake" not in line and "\n" not in line for line in lines)


def test_query_string_and_authorization_are_never_logged(client, access):
    client.get(
        "/api/v1/certificates/me?token=s3cr3t&x=1",
        headers={"Authorization": "Bearer sekrit-jwt", "X-User-Id": str(USER)},
    )

    (line,) = access()
    assert LINE.match(line).group("path") == "/api/v1/certificates/me"
    assert "s3cr3t" not in line and "sekrit" not in line and "Bearer" not in line


def test_healthcheck_is_not_logged(client, access):
    client.get("/healthcheck")

    assert access() == []


def test_client_errors_are_logged_once_each(client, access):
    client.get("/api/v1/certificates/me")  # 401
    client.get("/nope")  # 404

    assert [LINE.match(line).group("status") for line in access()] == ["401", "404"]


def test_unhandled_exception_logs_status_500_once(client, access):
    @app.get("/__boom")
    async def boom():
        raise RuntimeError("secret detail")

    try:
        with TestClient(app, raise_server_exceptions=False) as quiet:
            response = quiet.get("/__boom", headers={"X-Trace-Id": TRACE})
    finally:
        app.router.routes.pop()

    assert response.status_code == 500
    (line,) = access()
    fields = LINE.match(line).groupdict()
    assert fields["status"] == "500" and fields["path"] == "/__boom" and fields["trace"] == TRACE
    assert "secret" not in line
