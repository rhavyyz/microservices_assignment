from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.exc import OperationalError

from app import database


def test_database_check_requires_database_url(monkeypatch):
    monkeypatch.setattr(database, "settings", SimpleNamespace(database_url=None))

    with pytest.raises(database.DatabaseConfigurationError, match="DATABASE_URL is required"):
        database.check_database_connection()


def test_database_check_executes_select_one_with_sqlite(monkeypatch):
    engine = create_engine("sqlite://")
    monkeypatch.setattr(database, "settings", SimpleNamespace(database_url="sqlite://"))
    monkeypatch.setattr(database, "_create_engine", lambda _: engine)
    statements = []

    def capture_statement(conn, cursor, statement, *args):
        statements.append(statement)

    event.listen(engine, "before_cursor_execute", capture_statement)

    try:
        database.check_database_connection()
    finally:
        engine.dispose()

    assert statements == ["SELECT 1"]


def test_database_check_propagates_connection_errors(monkeypatch):
    error = OperationalError("SELECT 1", {}, OSError("database unavailable"))

    class UnavailableEngine:
        def connect(self):
            raise error

    monkeypatch.setattr(database, "settings", SimpleNamespace(database_url="postgresql+psycopg://db"))
    monkeypatch.setattr(database, "_create_engine", lambda _: UnavailableEngine())

    with pytest.raises(OperationalError) as raised:
        database.check_database_connection()

    assert raised.value is error
