from types import SimpleNamespace

from sqlalchemy.exc import SQLAlchemyError

from app import database
from app.api.routes import certificates


def test_healthcheck_without_database_configuration_is_unhealthy(client, monkeypatch):
    monkeypatch.setattr(database, "settings", SimpleNamespace(database_url=None))

    response = client.get("/healthcheck")

    assert response.status_code == 503
    assert response.json() == {"detail": "unhealthy"}


def test_healthcheck_checks_configured_database(client, monkeypatch):
    checks = []
    monkeypatch.setattr(certificates, "check_database_connection", lambda: checks.append(True))

    response = client.get("/healthcheck")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert checks == [True]


def test_healthcheck_reports_database_failure_without_details(client, monkeypatch):
    def failed_database_check():
        raise SQLAlchemyError("connection failed with secret details")

    monkeypatch.setattr(certificates, "check_database_connection", failed_database_check)

    response = client.get("/healthcheck")

    assert response.status_code == 503
    assert response.json() == {"detail": "unhealthy"}
    assert "secret" not in response.text
